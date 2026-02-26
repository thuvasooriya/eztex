// Watcher.zig -- platform-abstracted filesystem watcher.
// Uses kqueue (macOS/BSD) or inotify (Linux) for efficient FS event monitoring.
// Falls back to mtime polling on unsupported platforms.
// Not available on WASM (compile-time gated).
// Backend is comptime-selected to avoid pulling in inotify symbols on macOS or vice versa.

const Watcher = @This();
const std = @import("std");
const builtin = @import("builtin");
const posix = std.posix;
const c = std.c;
const fs = std.fs;
const Io = std.Io;
const Allocator = std.mem.Allocator;
const Host = @import("Host.zig");
const Log = @import("Log.zig");
const Compiler = @import("Compiler.zig");
const Project = @import("Project.zig");

// file extensions we watch for changes
const watched_extensions = [_][]const u8{ ".tex", ".bib", ".bst", ".cls", ".sty", ".def", ".cfg", ".clo", ".dtx", ".fd", ".zon" };

const is_mac = builtin.os.tag == .macos;
const is_linux = builtin.os.tag == .linux;
const is_windows = builtin.os.tag == .windows;
const has_kqueue = is_mac or builtin.os.tag == .freebsd or builtin.os.tag == .netbsd or builtin.os.tag == .openbsd or builtin.os.tag == .dragonfly;
const has_inotify = is_linux;

const BackendKind = enum { kqueue, inotify, poll };
const active_backend: BackendKind = if (has_kqueue) .kqueue else if (has_inotify) .inotify else .poll;

fn sleepMs(ms: u64) void {
    if (is_windows) {
        const windows = std.os.windows;
        const pSleep = @extern(*const fn (windows.DWORD) callconv(std.builtin.CallingConvention.winapi) void, .{ .name = "Sleep", .library_name = "kernel32" });
        pSleep(@intCast(ms));
    } else {
        const ts = std.c.timespec{
            .sec = @intCast(ms / 1000),
            .nsec = @intCast((ms % 1000) * 1_000_000),
        };
        _ = std.c.nanosleep(&ts, null);
    }
}

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
        mtime: Io.Timestamp,
    };
};

pub fn init(allocator: Allocator) !Watcher {
    if (comptime Host.is_wasm) @compileError("Watcher not available on WASM");

    const state: State = switch (active_backend) {
        .kqueue => blk: {
            const kq = posix.system.kqueue();
            if (kq == -1) return error.KqueueFailed;
            break :blk .{
                .kq = kq,
                .watched_fds = std.ArrayList(KqueueState.WatchedFd).empty,
            };
        },
        .inotify => .{
            .ifd = ifd: {
                const fd = c.inotify_init1(0);
                if (fd == -1) return error.InotifyInitFailed;
                break :ifd fd;
            },
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
                _ = posix.system.close(wf.fd);
                self.allocator.free(wf.path);
            }
            self.state.watched_fds.deinit(self.allocator);
            _ = posix.system.close(self.state.kq);
        },
        .inotify => {
            for (self.state.watch_descs.items) |wd| {
                _ = c.inotify_rm_watch(self.state.ifd, wd.wd);
                self.allocator.free(wd.dir_path);
            }
            self.state.watch_descs.deinit(self.allocator);
            _ = posix.system.close(self.state.ifd);
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
pub fn watch_dir(self: *Watcher, io: Io, dir_path: []const u8) !void {
    switch (active_backend) {
        .kqueue => try kqueue_watch_dir(self.allocator, io, &self.state, dir_path),
        .inotify => try inotify_watch_dir(self.allocator, &self.state, dir_path),
        .poll => try poll_watch_dir(self.allocator, io, &self.state, dir_path),
    }
}

// scan a directory recursively for watchable files.
pub fn watch_dir_recursive(self: *Watcher, io: Io, dir_path: []const u8) !void {
    try self.watch_dir(io, dir_path);
    var dir = Io.Dir.cwd().openDir(io, dir_path, .{ .iterate = true }) catch return;
    defer dir.close(io);
    var iter = dir.iterate();
    while (try iter.next(io)) |entry| {
        if (entry.kind == .directory) {
            if (entry.name.len > 0 and entry.name[0] == '.') continue;
            if (std.mem.eql(u8, entry.name, "zig-out")) continue;
            if (std.mem.eql(u8, entry.name, "zig-cache")) continue;
            if (std.mem.eql(u8, entry.name, ".zig-cache")) continue;
            if (std.mem.eql(u8, entry.name, "node_modules")) continue;
            const sub_path = try fs.path.join(self.allocator, &.{ dir_path, entry.name });
            defer self.allocator.free(sub_path);
            try self.watch_dir_recursive(io, sub_path);
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
pub fn wait_for_event(self: *Watcher, io: Io, timeout_ms: u32) !bool {
    return switch (active_backend) {
        .kqueue => kqueue_wait(&self.state, timeout_ms),
        .inotify => inotify_wait(&self.state, timeout_ms),
        .poll => poll_wait(io, &self.state, timeout_ms),
    };
}

// clear all watches. used after recompile to pick up new files.
pub fn reset(self: *Watcher) void {
    switch (active_backend) {
        .kqueue => {
            for (self.state.watched_fds.items) |wf| {
                _ = posix.system.close(wf.fd);
                self.allocator.free(wf.path);
            }
            self.state.watched_fds.clearRetainingCapacity();
        },
        .inotify => {
            for (self.state.watch_descs.items) |wd| {
                _ = c.inotify_rm_watch(self.state.ifd, wd.wd);
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

fn kqueue_watch_dir(allocator: Allocator, io: Io, kq: *KqueueState, dir_path: []const u8) !void {
    var dir = Io.Dir.cwd().openDir(io, dir_path, .{ .iterate = true }) catch return;
    defer dir.close(io);
    var iter = dir.iterate();
    while (try iter.next(io)) |entry| {
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

    const fd = posix.openat(posix.AT.FDCWD, file_path, .{}, 0) catch |err| {
        allocator.free(path_owned);
        return switch (err) {
            error.FileNotFound => {},
            else => err,
        };
    };
    errdefer _ = posix.system.close(fd);

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

    var dummy: [1]std.c.Kevent = undefined;
    const rc = std.c.kevent(kq.kq, @ptrCast(&change), 1, @ptrCast(&dummy), 0, null);
    if (rc == -1) return error.KeventFailed;
    try kq.watched_fds.append(allocator, .{ .fd = fd, .path = path_owned });
}

fn kqueue_wait(kq: *KqueueState, timeout_ms: u32) !bool {
    var events: [16]std.c.Kevent = undefined;
    const timeout = posix.timespec{
        .sec = @intCast(timeout_ms / 1000),
        .nsec = @intCast((@as(u64, timeout_ms) % 1000) * 1_000_000),
    };
    var dummy_change: [1]std.c.Kevent = undefined;
    const rc = std.c.kevent(kq.kq, @ptrCast(&dummy_change), 0, @ptrCast(&events), events.len, &timeout);
    if (rc == -1) return error.KeventFailed;
    return rc > 0;
}

// -- inotify implementation --

fn inotify_watch_dir(allocator: Allocator, ino: *InotifyState, dir_path: []const u8) !void {
    for (ino.watch_descs.items) |wd| {
        if (std.mem.eql(u8, wd.dir_path, dir_path)) return;
    }

    const IN = std.os.linux.IN;
    const mask = IN.CLOSE_WRITE | IN.CREATE | IN.DELETE | IN.MOVED_FROM | IN.MOVED_TO;
    const path_z = try allocator.dupeZ(u8, dir_path);
    defer allocator.free(path_z);
    const wd = c.inotify_add_watch(ino.ifd, path_z, mask);
    if (wd == -1) return; // silently ignore (file not found, access denied, etc.)

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

fn poll_watch_dir(allocator: Allocator, io: Io, p: *PollState, dir_path: []const u8) !void {
    var dir = Io.Dir.cwd().openDir(io, dir_path, .{ .iterate = true }) catch return;
    defer dir.close(io);
    var iter = dir.iterate();
    while (try iter.next(io)) |entry| {
        if (entry.kind != .file) continue;
        if (!is_watched_extension(entry.name)) continue;
        const full_path = try fs.path.join(allocator, &.{ dir_path, entry.name });
        errdefer allocator.free(full_path);
        try poll_add_file(allocator, io, p, full_path);
    }
}

fn poll_add_file(allocator: Allocator, io: Io, p: *PollState, file_path: []const u8) !void {
    for (p.files.items) |f| {
        if (std.mem.eql(u8, f.path, file_path)) return;
    }
    const st = Io.Dir.cwd().statFile(io, file_path, .{}) catch return;
    const path_owned = try allocator.dupe(u8, file_path);
    try p.files.append(allocator, .{ .path = path_owned, .mtime = st.mtime });
}

fn poll_wait(io: Io, p: *PollState, timeout_ms: u32) !bool {
    const interval_ms: u64 = 200;
    var elapsed: u64 = 0;

    while (elapsed < timeout_ms) {
        sleepMs(interval_ms);
        elapsed += interval_ms;

        for (p.files.items) |*f| {
            const st = Io.Dir.cwd().statFile(io, f.path, .{}) catch continue;
            if (st.mtime.nanoseconds != f.mtime.nanoseconds) {
                f.mtime = st.mtime;
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

// -- watch command (integrated from main.zig) --

pub fn do_watch(io: Io, config: Compiler.CompileConfig) u8 {
    if (comptime Host.is_wasm) {
        Log.log(io, "eztex", .err, "watch mode is not supported on WASM", .{});
        return 1;
    }

    const input_file = config.input_file orelse {
        Log.log(io, "eztex", .err, "no input file specified for watch", .{});
        return 1;
    };

    const project = Project.resolve_project_input(io, std.heap.c_allocator, input_file, config.verbose) orelse return 1;
    defer if (project.temp_dir) |tmp| {
        Io.Dir.cwd().deleteTree(io, tmp) catch {};
    };

    Io.Dir.cwd().access(io, project.tex_file, .{}) catch {
        Log.log(io, "eztex", .err, "input file '{s}' not found", .{project.tex_file});
        return 1;
    };

    const watch_root = project.project_dir orelse std.fs.path.dirname(project.tex_file) orelse ".";

    var watcher = Watcher.init(std.heap.c_allocator) catch |err| {
        Log.log(io, "eztex", .err, "failed to initialize file watcher: {}", .{err});
        return 1;
    };
    defer watcher.deinit();

    watcher.watch_dir_recursive(io, watch_root) catch |err| {
        Log.log(io, "eztex", .err, "failed to watch directory '{s}': {}", .{ watch_root, err });
        return 1;
    };

    Log.log(io, "eztex", .info, "watching '{s}' ({d} files) for changes... (Ctrl+C to stop)", .{ watch_root, watcher.watched_count() });

    Log.log(io, "eztex", .info, "initial compile...", .{});
    _ = Compiler.compile(io, &config, null);

    const debounce_ms: u32 = 200;
    while (true) {
        const got_event = watcher.wait_for_event(io, 60_000) catch |err| {
            Log.log(io, "eztex", .warn, "watcher error: {}", .{err});
            sleepMs(1); // 1ms backoff
            continue;
        };
        if (!got_event) continue;

        while (true) {
            const more = watcher.wait_for_event(io, debounce_ms) catch break;
            if (!more) break;
        }

        Log.log(io, "eztex", .info, "change detected, recompiling...", .{});
        _ = Compiler.compile(io, &config, null);

        watcher.reset();
        watcher.watch_dir_recursive(io, watch_root) catch |err| {
            Log.log(io, "eztex", .warn, "failed to re-watch directory: {}", .{err});
        };
        Log.dbg(io, "eztex", "re-watching {d} files", .{watcher.watched_count()});
    }
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

// Io parameter for wait_for_event dispatch
test "poll_wait with io" {
    // This test is a placeholder to ensure poll_wait signature is correct
    // Real testing would require file system setup
}
