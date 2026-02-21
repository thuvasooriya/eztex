// Watcher.zig -- platform-abstracted filesystem watcher.
// Uses kqueue (macOS/BSD) or inotify (Linux) for efficient FS event monitoring.
// Falls back to mtime polling on unsupported platforms.
// Not available on WASM (compile-time gated).
// Backend is comptime-selected to avoid pulling in inotify symbols on macOS or vice versa.

const Watcher = @This();
const std = @import("std");
const builtin = @import("builtin");
const posix = std.posix;
const fs = std.fs;
const Allocator = std.mem.Allocator;
const Host = @import("Host.zig");
const Log = @import("Log.zig");

// file extensions we watch for changes
const watched_extensions = [_][]const u8{ ".tex", ".bib", ".bst", ".cls", ".sty", ".def", ".cfg", ".clo", ".dtx", ".fd", ".zon" };

const is_mac = builtin.os.tag == .macos;
const is_linux = builtin.os.tag == .linux;
const has_kqueue = is_mac or builtin.os.tag == .freebsd or builtin.os.tag == .netbsd or builtin.os.tag == .openbsd or builtin.os.tag == .dragonfly;
const has_inotify = is_linux;

const BackendKind = enum { kqueue, inotify, poll };
const active_backend: BackendKind = if (has_kqueue) .kqueue else if (has_inotify) .inotify else .poll;

pub const Event = struct {
    kind: Kind,
    pub const Kind = enum { modified, created, deleted };
};

allocator: Allocator,
state: State,

// comptime-selected state type -- only one variant exists per target
const State = switch (active_backend) {
    .kqueue => KqueueState,
    .inotify => InotifyState,
    .poll => PollState,
};

// -- kqueue state (macOS/BSD) --

const KqueueState = struct {
    kq: i32,
    watched_fds: std.ArrayList(WatchedFd),

    const WatchedFd = struct {
        fd: posix.fd_t,
        path: []const u8,
    };
};

// -- inotify state (Linux) --

const InotifyState = struct {
    ifd: i32,
    watch_descs: std.ArrayList(WatchDesc),

    const WatchDesc = struct {
        wd: i32,
        dir_path: []const u8,
    };
};

// -- poll fallback state --

const PollState = struct {
    files: std.ArrayList(PollFile),

    const PollFile = struct {
        path: []const u8,
        mtime: i128,
    };
};

pub fn init(allocator: Allocator) !Watcher {
    if (comptime Host.is_wasm) @compileError("Watcher not available on WASM");

    const state: State = switch (active_backend) {
        .kqueue => .{
            .kq = try posix.kqueue(),
            .watched_fds = std.ArrayList(KqueueState.WatchedFd).empty,
        },
        .inotify => .{
            .ifd = try posix.inotify_init1(0),
            .watch_descs = std.ArrayList(InotifyState.WatchDesc).empty,
        },
        .poll => .{
            .files = std.ArrayList(PollState.PollFile).empty,
        },
    };
    return .{ .allocator = allocator, .state = state };
}

pub fn deinit(self: *Watcher) void {
    switch (active_backend) {
        .kqueue => {
            for (self.state.watched_fds.items) |wf| {
                posix.close(wf.fd);
                self.allocator.free(wf.path);
            }
            self.state.watched_fds.deinit(self.allocator);
            posix.close(self.state.kq);
        },
        .inotify => {
            for (self.state.watch_descs.items) |wd| {
                posix.inotify_rm_watch(self.state.ifd, wd.wd);
                self.allocator.free(wd.dir_path);
            }
            self.state.watch_descs.deinit(self.allocator);
            posix.close(self.state.ifd);
        },
        .poll => {
            for (self.state.files.items) |f| {
                self.allocator.free(f.path);
            }
            self.state.files.deinit(self.allocator);
        },
    }
}

// scan a directory (non-recursively) for watchable files and add them.
pub fn watch_dir(self: *Watcher, dir_path: []const u8) !void {
    switch (active_backend) {
        .kqueue => try kqueue_watch_dir(self.allocator, &self.state, dir_path),
        .inotify => try inotify_watch_dir(self.allocator, &self.state, dir_path),
        .poll => try poll_watch_dir(self.allocator, &self.state, dir_path),
    }
}

// scan a directory recursively for watchable files.
pub fn watch_dir_recursive(self: *Watcher, dir_path: []const u8) !void {
    try self.watch_dir(dir_path);
    var dir = fs.cwd().openDir(dir_path, .{ .iterate = true }) catch return;
    defer dir.close();
    var iter = dir.iterate();
    while (try iter.next()) |entry| {
        if (entry.kind == .directory) {
            if (entry.name.len > 0 and entry.name[0] == '.') continue;
            if (std.mem.eql(u8, entry.name, "zig-out")) continue;
            if (std.mem.eql(u8, entry.name, "zig-cache")) continue;
            if (std.mem.eql(u8, entry.name, ".zig-cache")) continue;
            if (std.mem.eql(u8, entry.name, "node_modules")) continue;
            const sub_path = try fs.path.join(self.allocator, &.{ dir_path, entry.name });
            defer self.allocator.free(sub_path);
            try self.watch_dir_recursive(sub_path);
        }
    }
}

// add a single file to the watch set.
pub fn watch_file(self: *Watcher, file_path: []const u8) !void {
    switch (active_backend) {
        .kqueue => try kqueue_add_file(self.allocator, &self.state, file_path),
        .inotify => {
            const dir = fs.path.dirname(file_path) orelse ".";
            try self.watch_dir(dir);
        },
        .poll => try poll_add_file(self.allocator, &self.state, file_path),
    }
}

// wait for a filesystem event. blocks until an event occurs or timeout_ms elapses.
// returns true if an event was detected, false on timeout.
pub fn wait_for_event(self: *Watcher, timeout_ms: u32) !bool {
    return switch (active_backend) {
        .kqueue => kqueue_wait(&self.state, timeout_ms),
        .inotify => inotify_wait(&self.state, timeout_ms),
        .poll => poll_wait(&self.state, timeout_ms),
    };
}

// clear all watches. used after recompile to pick up new files.
pub fn reset(self: *Watcher) void {
    switch (active_backend) {
        .kqueue => {
            for (self.state.watched_fds.items) |wf| {
                posix.close(wf.fd);
                self.allocator.free(wf.path);
            }
            self.state.watched_fds.clearRetainingCapacity();
        },
        .inotify => {
            for (self.state.watch_descs.items) |wd| {
                posix.inotify_rm_watch(self.state.ifd, wd.wd);
                self.allocator.free(wd.dir_path);
            }
            self.state.watch_descs.clearRetainingCapacity();
        },
        .poll => {
            for (self.state.files.items) |f| {
                self.allocator.free(f.path);
            }
            self.state.files.clearRetainingCapacity();
        },
    }
}

pub fn watched_count(self: *const Watcher) usize {
    return switch (active_backend) {
        .kqueue => self.state.watched_fds.items.len,
        .inotify => self.state.watch_descs.items.len,
        .poll => self.state.files.items.len,
    };
}

// -- kqueue implementation --

fn kqueue_watch_dir(allocator: Allocator, kq: *KqueueState, dir_path: []const u8) !void {
    var dir = fs.cwd().openDir(dir_path, .{ .iterate = true }) catch return;
    defer dir.close();
    var iter = dir.iterate();
    while (try iter.next()) |entry| {
        if (entry.kind != .file) continue;
        if (!is_watched_extension(entry.name)) continue;
        const full_path = try fs.path.join(allocator, &.{ dir_path, entry.name });
        errdefer allocator.free(full_path);
        try kqueue_add_file(allocator, kq, full_path);
    }
}

fn kqueue_add_file(allocator: Allocator, kq: *KqueueState, file_path: []const u8) !void {
    for (kq.watched_fds.items) |wf| {
        if (std.mem.eql(u8, wf.path, file_path)) return;
    }

    const path_owned = try allocator.dupe(u8, file_path);
    errdefer allocator.free(path_owned);

    const fd = posix.open(file_path, .{}, 0) catch |err| {
        allocator.free(path_owned);
        return switch (err) {
            error.FileNotFound => {},
            else => err,
        };
    };
    errdefer posix.close(fd);

    const EV = std.c.EV;
    const NOTE = std.c.NOTE;
    const change = std.c.Kevent{
        .ident = @intCast(fd),
        .filter = std.c.EVFILT.VNODE,
        .flags = EV.ADD | EV.ENABLE | EV.CLEAR,
        .fflags = NOTE.WRITE | NOTE.DELETE | NOTE.RENAME | NOTE.ATTRIB,
        .data = 0,
        .udata = 0,
    };

    _ = try posix.kevent(kq.kq, &.{change}, &.{}, null);
    try kq.watched_fds.append(allocator, .{ .fd = fd, .path = path_owned });
}

fn kqueue_wait(kq: *KqueueState, timeout_ms: u32) !bool {
    var events: [16]std.c.Kevent = undefined;
    const timeout = posix.timespec{
        .sec = @intCast(timeout_ms / 1000),
        .nsec = @intCast((@as(u64, timeout_ms) % 1000) * 1_000_000),
    };
    const n = try posix.kevent(kq.kq, &.{}, &events, &timeout);
    return n > 0;
}

// -- inotify implementation --

fn inotify_watch_dir(allocator: Allocator, ino: *InotifyState, dir_path: []const u8) !void {
    for (ino.watch_descs.items) |wd| {
        if (std.mem.eql(u8, wd.dir_path, dir_path)) return;
    }

    const IN = std.os.linux.IN;
    const mask = IN.CLOSE_WRITE | IN.CREATE | IN.DELETE | IN.MOVED_FROM | IN.MOVED_TO;
    const wd = posix.inotify_add_watch(ino.ifd, dir_path, mask) catch |err| {
        return switch (err) {
            error.FileNotFound, error.AccessDenied => {},
            else => err,
        };
    };

    const path_owned = try allocator.dupe(u8, dir_path);
    try ino.watch_descs.append(allocator, .{ .wd = wd, .dir_path = path_owned });
}

fn inotify_wait(ino: *InotifyState, timeout_ms: u32) !bool {
    var poll_fds = [_]posix.pollfd{.{
        .fd = ino.ifd,
        .events = posix.POLL.IN,
        .revents = 0,
    }};

    const n = try posix.poll(&poll_fds, @intCast(timeout_ms));
    if (n == 0) return false;

    var buf: [4096]u8 align(@alignOf(std.os.linux.inotify_event)) = undefined;
    var found_relevant = false;
    while (true) {
        const bytes_read = posix.read(ino.ifd, &buf) catch |err| {
            return switch (err) {
                error.WouldBlock => found_relevant,
                else => err,
            };
        };
        if (bytes_read == 0) break;
        var offset: usize = 0;
        while (offset < bytes_read) {
            const event: *const std.os.linux.inotify_event = @ptrCast(@alignCast(&buf[offset]));
            const name = event.getName();
            if (name) |n_slice| {
                if (is_watched_extension(n_slice)) {
                    found_relevant = true;
                }
            } else {
                found_relevant = true;
            }
            offset += @sizeOf(std.os.linux.inotify_event) + event.len;
        }
        break;
    }
    return found_relevant;
}

// -- poll fallback --

fn poll_watch_dir(allocator: Allocator, p: *PollState, dir_path: []const u8) !void {
    var dir = fs.cwd().openDir(dir_path, .{ .iterate = true }) catch return;
    defer dir.close();
    var iter = dir.iterate();
    while (try iter.next()) |entry| {
        if (entry.kind != .file) continue;
        if (!is_watched_extension(entry.name)) continue;
        const full_path = try fs.path.join(allocator, &.{ dir_path, entry.name });
        errdefer allocator.free(full_path);
        try poll_add_file(allocator, p, full_path);
    }
}

fn poll_add_file(allocator: Allocator, p: *PollState, file_path: []const u8) !void {
    for (p.files.items) |f| {
        if (std.mem.eql(u8, f.path, file_path)) return;
    }
    const stat = fs.cwd().statFile(file_path) catch return;
    const path_owned = try allocator.dupe(u8, file_path);
    try p.files.append(allocator, .{ .path = path_owned, .mtime = stat.mtime });
}

fn poll_wait(p: *PollState, timeout_ms: u32) !bool {
    const interval_ms: u64 = 200;
    var elapsed: u64 = 0;

    while (elapsed < timeout_ms) {
        std.Thread.sleep(interval_ms * std.time.ns_per_ms);
        elapsed += interval_ms;

        for (p.files.items) |*f| {
            const stat = fs.cwd().statFile(f.path) catch continue;
            if (stat.mtime != f.mtime) {
                f.mtime = stat.mtime;
                return true;
            }
        }
    }
    return false;
}

// -- helpers --

pub fn is_watched_extension(name: []const u8) bool {
    for (watched_extensions) |ext| {
        if (std.mem.endsWith(u8, name, ext)) return true;
    }
    return false;
}

// -- tests --

test "is_watched_extension" {
    const expect = std.testing.expect;
    try expect(is_watched_extension("main.tex"));
    try expect(is_watched_extension("refs.bib"));
    try expect(is_watched_extension("my.cls"));
    try expect(is_watched_extension("custom.sty"));
    try expect(is_watched_extension("eztex.zon"));
    try expect(!is_watched_extension("image.png"));
    try expect(!is_watched_extension("output.pdf"));
    try expect(!is_watched_extension("binary.o"));
    try expect(!is_watched_extension("Makefile"));
}
