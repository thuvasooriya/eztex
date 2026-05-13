import { type Component, For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type { ProjectStore } from "../lib/project_store";
import { is_binary } from "../lib/project_store";
import { worker_client } from "../lib/worker_client";
import { is_modal_open } from "../lib/modal_store";
import { current_focus_target, restore_focus, trap_tab_key } from "../lib/focus_utils";
import AnimatedShow from "./AnimatedShow";

type SearchResult = {
  file: string;
  line: number;
  column: number;
  snippet: string;
};

type FileGroup = {
  file: string;
  results: SearchResult[];
};

type Props = {
  store: ProjectStore;
  show: boolean;
  on_close: () => void;
};

function search_file(file: string, text: string, query: string, case_sensitive: boolean): SearchResult[] {
  const needle = case_sensitive ? query : query.toLowerCase();
  const results: SearchResult[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const haystack = case_sensitive ? lines[i] : lines[i].toLowerCase();
    let index = haystack.indexOf(needle);
    while (index >= 0) {
      const start = Math.max(0, index - 48);
      const end = Math.min(lines[i].length, index + query.length + 72);
      const prefix = start > 0 ? "..." : "";
      const suffix = end < lines[i].length ? "..." : "";
      results.push({
        file,
        line: i + 1,
        column: index + 1,
        snippet: `${prefix}${lines[i].slice(start, end)}${suffix}`,
      });
      index = haystack.indexOf(needle, index + Math.max(1, needle.length));
    }
  }
  return results;
}

function line_column_to_offset(text: string, line: number, column: number): number | null {
  let current_line = 1;
  let offset = 0;
  while (current_line < line) {
    const next = text.indexOf("\n", offset);
    if (next < 0) return null;
    offset = next + 1;
    current_line++;
  }
  return offset + column - 1;
}

function match_at(text: string, query: string, offset: number, case_sensitive: boolean): boolean {
  const part = text.slice(offset, offset + query.length);
  return case_sensitive ? part === query : part.toLowerCase() === query.toLowerCase();
}

function replace_all_literal(text: string, query: string, replacement: string, case_sensitive: boolean): { text: string; count: number } {
  if (!query) return { text, count: 0 };
  const needle = case_sensitive ? query : query.toLowerCase();
  const haystack = case_sensitive ? text : text.toLowerCase();
  let count = 0;
  let offset = 0;
  let out = "";
  while (true) {
    const index = haystack.indexOf(needle, offset);
    if (index < 0) break;
    out += text.slice(offset, index) + replacement;
    offset = index + query.length;
    count++;
  }
  if (count === 0) return { text, count: 0 };
  return { text: out + text.slice(offset), count };
}

const SearchPanel: Component<Props> = (props) => {
  let input_ref: HTMLInputElement | undefined;
  let panel_ref: HTMLElement | undefined;
  let restore_target: HTMLElement | null = null;
  const [query, set_query] = createSignal("");
  const [replacement, set_replacement] = createSignal("");
  const [case_sensitive, set_case_sensitive] = createSignal(false);
  const [replace_status, set_replace_status] = createSignal("");

  const groups = createMemo<FileGroup[]>(() => {
    const q = query();
    props.store.content_revision();
    if (!q) return [];
    const next: FileGroup[] = [];
    for (const file of props.store.file_names()) {
      if (is_binary(file)) continue;
      const content = props.store.get_content(file);
      if (typeof content !== "string") continue;
      const results = search_file(file, content, q, case_sensitive());
      if (results.length > 0) next.push({ file, results });
    }
    return next;
  });

  const total_results = createMemo(() => groups().reduce((sum, group) => sum + group.results.length, 0));

  createEffect(() => {
    if (!props.show) return;
    restore_target = current_focus_target();
    requestAnimationFrame(() => input_ref?.focus({ preventScroll: true }));

    const on_key = (e: KeyboardEvent) => {
      if (is_modal_open()) return;
      handle_keydown(e);
    };
    document.addEventListener("keydown", on_key);
    onCleanup(() => {
      document.removeEventListener("keydown", on_key);
      const target = restore_target;
      restore_target = null;
      restore_focus(target);
    });
  });

  function jump_to(result: SearchResult) {
    props.store.set_current_file(result.file);
    worker_client.request_goto(result.file, result.line);
    props.on_close();
  }

  function replace_result(result: SearchResult) {
    const q = query();
    if (!q) return;
    const content = props.store.get_content(result.file);
    if (typeof content !== "string") return;
    const offset = line_column_to_offset(content, result.line, result.column);
    if (offset === null || !match_at(content, q, offset, case_sensitive())) {
      set_replace_status("Match changed; run search again.");
      return;
    }
    const flat_results = groups().flatMap((group) => group.results);
    const index = flat_results.findIndex((item) => item.file === result.file && item.line === result.line && item.column === result.column);
    const next_result = index >= 0 ? flat_results[index + 1] ?? flat_results[0] : null;
    props.store.update_content(result.file, `${content.slice(0, offset)}${replacement()}${content.slice(offset + q.length)}`);
    if (next_result) {
      props.store.set_current_file(next_result.file);
      worker_client.request_goto(next_result.file, next_result.line);
    } else {
      props.store.set_current_file(result.file);
      worker_client.request_goto(result.file, result.line);
    }
    set_replace_status(`Replaced 1 occurrence in ${result.file}.`);
  }

  function replace_in_file(file: string): number {
    const q = query();
    if (!q) return 0;
    const content = props.store.get_content(file);
    if (typeof content !== "string") return 0;
    const result = replace_all_literal(content, q, replacement(), case_sensitive());
    if (result.count > 0) props.store.update_content(file, result.text);
    return result.count;
  }

  function replace_current_file() {
    const file = props.store.current_file();
    if (!file || is_binary(file)) return;
    const count = replace_in_file(file);
    set_replace_status(`Replaced ${count} occurrence${count === 1 ? "" : "s"} in ${file}.`);
  }

  function replace_all() {
    let occurrences = 0;
    let files = 0;
    for (const file of props.store.file_names()) {
      if (is_binary(file)) continue;
      const count = replace_in_file(file);
      if (count > 0) {
        occurrences += count;
        files++;
      }
    }
    set_replace_status(`Replaced ${occurrences} occurrence${occurrences === 1 ? "" : "s"} in ${files} file${files === 1 ? "" : "s"}.`);
  }

  function handle_keydown(e: KeyboardEvent) {
    if (e.key === "Tab" && panel_ref) {
      trap_tab_key(e, panel_ref);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      props.on_close();
    }
  }

  return (
    <AnimatedShow when={props.show}>
      <div class="search-backdrop" onClick={props.on_close}>
        <section ref={panel_ref} class="search-panel" role="dialog" aria-modal="true" aria-label="Search in project" tabindex="-1" onClick={(e) => e.stopPropagation()} onKeyDown={handle_keydown}>
          <div class="search-panel-header">
            <div>
              <div class="search-panel-title">Search in Project</div>
              <div class="search-panel-subtitle">Search text files across the current project.</div>
            </div>
            <button class="search-panel-close" onClick={props.on_close} aria-label="Close search panel">x</button>
          </div>
          <div class="search-panel-controls">
            <input
              ref={input_ref}
              class="search-input"
              value={query()}
              onInput={(e) => { set_query(e.currentTarget.value); set_replace_status(""); }}
              placeholder="Search text..."
              autocomplete="off"
              spellcheck={false}
            />
            <input
              class="search-input"
              value={replacement()}
              onInput={(e) => { set_replacement(e.currentTarget.value); set_replace_status(""); }}
              placeholder="Replace with..."
              autocomplete="off"
              spellcheck={false}
            />
            <div class="search-replace-actions">
              <button disabled={!query()} onClick={replace_current_file}>Replace in Current File</button>
              <button disabled={!query() || total_results() === 0} onClick={replace_all}>Replace All</button>
            </div>
            <label class="search-toggle">
              <input type="checkbox" checked={case_sensitive()} onChange={(e) => set_case_sensitive(e.currentTarget.checked)} />
              Case sensitive
            </label>
          </div>
          <div class="search-summary">
            <Show when={replace_status()} fallback={query() ? `${total_results()} result${total_results() === 1 ? "" : "s"}` : "Enter a query to search project files."}>
              {replace_status()}
            </Show>
          </div>
          <div class="search-results">
            <For each={groups()}>
              {(group) => (
                <div class="search-file-group">
                  <div class="search-file-title">{group.file}</div>
                  <For each={group.results}>
                    {(result) => (
                      <div class="search-result-row">
                        <button class="search-result" onClick={() => jump_to(result)}>
                        <span class="search-result-location">{result.file}:{result.line}</span>
                        <span class="search-result-snippet">{result.snippet}</span>
                        </button>
                        <button class="search-result-replace" disabled={!query()} onClick={() => replace_result(result)}>Replace</button>
                      </div>
                    )}
                  </For>
                </div>
              )}
            </For>
            <Show when={query() && groups().length === 0}>
              <div class="search-empty">No matches found.</div>
            </Show>
          </div>
        </section>
      </div>
    </AnimatedShow>
  );
};

export default SearchPanel;
