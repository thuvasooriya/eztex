import { type Component, onMount, onCleanup, createEffect, on, Show, createSignal, createMemo } from "solid-js";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightSpecialChars, drawSelection } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { defaultKeymap, indentWithTab } from "@codemirror/commands";
import {
  StreamLanguage,
  syntaxHighlighting,
  HighlightStyle,
  bracketMatching,
  indentOnInput,
  foldGutter,
} from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { tags } from "@lezer/highlight";
import { setDiagnostics as cmSetDiagnostics, type Diagnostic as CmDiagnostic } from "@codemirror/lint";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import * as Y from "yjs";
import type { ProjectStore } from "../lib/project_store";
import { is_binary } from "../lib/project_store";
import { worker_client } from "../lib/worker_client";

type Props = {
  store: ProjectStore;
  vim_enabled: boolean;
  word_wrap: boolean;
  editor_font_size: "small" | "medium" | "large";
  read_only?: boolean;
  on_editor_view: (view: EditorView) => void;
};

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);

function get_image_mime(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = name.slice(dot).toLowerCase();
  if (!IMAGE_EXTS.has(ext)) return null;
  const map: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
  };
  return map[ext] ?? null;
}

const tokyo_night_theme = EditorView.theme({
  "&": {
    backgroundColor: "transparent",
    color: "var(--fg)",
    height: "100%",
  },
  ".cm-content": {
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: "13.5px",
    lineHeight: "1.7",
    caretColor: "var(--accent)",
    padding: "12px 0",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--accent)",
    borderLeftWidth: "2px",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "rgba(122, 162, 247, 0.2) !important",
  },
  ".cm-activeLine": {
    backgroundColor: "rgba(41, 46, 66, 0.4)",
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--fg-dark)",
    border: "none",
    paddingRight: "4px",
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: "13.5px",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: "var(--fg-muted)",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    padding: "0 8px 0 12px",
    minWidth: "3em",
    fontSize: "13.5px",
    lineHeight: "1.7",
  },
  ".cm-foldGutter .cm-gutterElement": {
    padding: "0 4px",
  },
  "&.cm-focused": {
    outline: "none",
  },
  ".cm-scroller": {
    overflow: "auto",
    fontFamily: "'JetBrains Mono', monospace",
  },
  ".cm-matchingBracket": {
    backgroundColor: "rgba(122, 162, 247, 0.3)",
    color: "inherit !important",
    outline: "1px solid rgba(122, 162, 247, 0.5)",
  },
  ".cm-tooltip": {
    backgroundColor: "var(--bg-lighter)",
    color: "var(--fg)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-md)",
    boxShadow: "0 4px 12px rgba(0, 0, 0, 0.3)",
    overflow: "hidden",
  },
  ".cm-tooltip.cm-tooltip-lint": {
    padding: "0",
    margin: "0",
  },
  ".cm-diagnostic": {
    fontFamily: "var(--font-mono)",
    fontSize: "12px",
    padding: "3px 6px",
    borderLeft: "3px solid",
  },
  ".cm-diagnostic-error": {
    borderLeftColor: "var(--red)",
    background: "rgba(247, 118, 142, 0.08)",
    color: "var(--red)",
  },
  ".cm-diagnostic-warning": {
    borderLeftColor: "var(--yellow)",
    background: "rgba(224, 175, 104, 0.08)",
    color: "var(--yellow)",
  },
  ".cm-diagnosticSource": {
    fontSize: "70%",
    opacity: "0.6",
    color: "var(--fg-muted)",
  },
  ".cm-ySelectionInfo": {
    position: "absolute",
    top: "-1.55em",
    left: "-1px",
    padding: "2px 6px",
    border: "0",
    borderRadius: "var(--radius-sm)",
    borderBottomLeftRadius: "0",
    color: "var(--bg-dark)",
    fontFamily: "var(--font-mono)",
    fontSize: "10.5px",
    fontWeight: "700",
    lineHeight: "1.2",
    whiteSpace: "nowrap",
    pointerEvents: "none",
    userSelect: "none",
    opacity: "1",
    zIndex: "20",
  },
  ".cm-ySelectionCaretDot": {
    display: "none",
  },
}, { dark: true });

const tokyo_night_highlight = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--syntax-keyword)" },
  { tag: tags.comment, color: "var(--syntax-comment)", fontStyle: "italic" },
  { tag: tags.string, color: "var(--syntax-string)" },
  { tag: tags.number, color: "var(--syntax-number)" },
  { tag: tags.operator, color: "var(--syntax-operator)" },
  { tag: tags.meta, color: "var(--syntax-meta)" },
  { tag: tags.bracket, color: "var(--syntax-bracket)" },
  { tag: tags.tagName, color: "var(--syntax-tag)" },
  { tag: tags.attributeName, color: "var(--syntax-attr-name)" },
  { tag: tags.attributeValue, color: "var(--syntax-attr-value)" },
  { tag: tags.definition(tags.variableName), color: "var(--syntax-definition)" },
  { tag: tags.atom, color: "var(--syntax-atom)" },
  { tag: tags.typeName, color: "var(--syntax-type)" },
  { tag: tags.className, color: "var(--syntax-type)" },
  { tag: tags.propertyName, color: "var(--syntax-property)" },
  { tag: tags.variableName, color: "var(--syntax-variable)" },
  { tag: tags.bool, color: "var(--syntax-bool)" },
  { tag: tags.null, color: "var(--syntax-bool)" },
  { tag: tags.processingInstruction, color: "var(--syntax-definition)" },
]);

const EDITOR_FONT_SIZES: Record<Props["editor_font_size"], string> = {
  small: "12.5px",
  medium: "13.5px",
  large: "15px",
};

function editor_font_size_theme(size: Props["editor_font_size"]) {
  const fontSize = EDITOR_FONT_SIZES[size];
  return EditorView.theme({
    ".cm-content": { fontSize },
    ".cm-gutters": { fontSize },
    ".cm-lineNumbers .cm-gutterElement": { fontSize },
  });
}

const Editor: Component<Props> = (props) => {
  let container_ref: HTMLDivElement | undefined;
  let view: EditorView | undefined;

  const vim_compartment = new Compartment();
  const line_wrap_compartment = new Compartment();
  const font_size_compartment = new Compartment();
  const undo_managers = new Map<string, Y.UndoManager>();

  function get_undo_manager(path: string, ytext: Y.Text): Y.UndoManager {
    let manager = undo_managers.get(path);
    if (!manager) {
      manager = new Y.UndoManager(ytext);
      undo_managers.set(path, manager);
    }
    return manager;
  }

  const current_is_binary = createMemo(() => is_binary(props.store.current_file()));

  const image_mime = createMemo(() => {
    const name = props.store.current_file();
    if (!current_is_binary()) return null;
    return get_image_mime(name);
  });

  const [image_url, set_image_url] = createSignal<string | null>(null);

  createEffect(
    on(
      () => ({ file: props.store.current_file(), mime: image_mime() }),
      ({ file, mime }) => {
        const prev = image_url();
        if (prev) URL.revokeObjectURL(prev);
        set_image_url(null);

        if (!mime) return;
        const content = props.store.get_content(file);
        if (!(content instanceof Uint8Array)) return;
        const bytes = new Uint8Array(content.byteLength);
        bytes.set(content);
        const blob = new Blob([bytes], { type: mime });
        set_image_url(URL.createObjectURL(blob));
      },
    ),
  );

  onCleanup(() => {
    const url = image_url();
    if (url) URL.revokeObjectURL(url);
  });

  let sync_timer: ReturnType<typeof setTimeout> | undefined;
  let goto_reset_timer: ReturnType<typeof setTimeout> | undefined;
  let suppress_forward_sync = false;
  const read_only_compartment = new Compartment();

  function update_cursor_presence(editor: EditorView, doc_changed: boolean): void {
    const awareness = props.store.awareness();
    const line = editor.state.doc.lineAt(editor.state.selection.main.head).number;
    awareness.setLocalStateField("cursor_file", props.store.current_file());
    awareness.setLocalStateField("cursor_line", line);
    awareness.setLocalStateField("last_active_at", Date.now());
    if (doc_changed) {
      const state = awareness.getLocalState();
      const edit_count = typeof state?.edit_count === "number" ? state.edit_count : 0;
      awareness.setLocalStateField("edit_count", edit_count + 1);
    }
  }

  function base_extensions(ytext: Y.Text, undoManager: Y.UndoManager, readOnly: boolean): any[] {
    return [
      lineNumbers(),
      highlightActiveLine(),
      highlightSpecialChars(),
      drawSelection(),
      bracketMatching(),
      indentOnInput(),
      foldGutter(),
      StreamLanguage.define(stex),
      syntaxHighlighting(tokyo_night_highlight),
      tokyo_night_theme,
      yCollab(ytext, props.store.awareness(), { undoManager }),
      keymap.of([...defaultKeymap, ...yUndoManagerKeymap, indentWithTab]),
      vim_compartment.of([]),
      line_wrap_compartment.of(props.word_wrap ? EditorView.lineWrapping : []),
      font_size_compartment.of(editor_font_size_theme(props.editor_font_size)),
      read_only_compartment.of(readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
      EditorView.updateListener.of((update) => {
        if (update.selectionSet || update.docChanged) {
          update_cursor_presence(update.view, update.docChanged);
          schedule_forward_synctex();
        }
      }),
    ];
  }

  function create_editor_state(ytext: Y.Text, undoManager: Y.UndoManager): EditorState {
    return EditorState.create({
      doc: ytext.toString(),
      extensions: base_extensions(ytext, undoManager, props.read_only ?? false),
    });
  }

  function schedule_forward_synctex() {
    if (sync_timer !== undefined) clearTimeout(sync_timer);
    sync_timer = setTimeout(() => {
      if (suppress_forward_sync || !view) {
        return;
      }
      const line = view.state.doc.lineAt(view.state.selection.main.head).number;
      worker_client.sync_forward(props.store.current_file(), line);
    }, 300);
  }

  onMount(() => {
    if (!container_ref) return;

    const file = props.store.current_file();
    const ytext = props.store.get_ytext(file);
    const undoManager = get_undo_manager(file, ytext);
    const state = create_editor_state(ytext, undoManager);

    view = new EditorView({
      state,
      parent: container_ref,
    });

    props.on_editor_view(view);
    update_cursor_presence(view, false);

    if (props.vim_enabled) {
      import("@replit/codemirror-vim").then(({ vim }) => {
        if (view) view.dispatch({ effects: vim_compartment.reconfigure(vim()) });
      });
    }
  });

  createEffect(
    on(
      () => props.vim_enabled,
      (enabled) => {
        if (!view) return;
        if (enabled) {
          import("@replit/codemirror-vim").then(({ vim }) => {
            if (view) view.dispatch({ effects: vim_compartment.reconfigure(vim()) });
          });
        } else {
          view.dispatch({ effects: vim_compartment.reconfigure([]) });
        }
      },
    ),
  );

  createEffect(
    on(
      () => props.read_only,
      (readOnly) => {
        if (!view) return;
        const extensions = readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [];
        view.dispatch({ effects: read_only_compartment.reconfigure(extensions) });
      },
    ),
  );

  createEffect(() => {
    const active_files = new Set(props.store.file_names());
    for (const [path, manager] of undo_managers) {
      if (!active_files.has(path)) {
        manager.destroy();
        undo_managers.delete(path);
      }
    }
  });

  createEffect(
    on(
      () => props.word_wrap,
      (wordWrap) => {
        if (!view) return;
        view.dispatch({ effects: line_wrap_compartment.reconfigure(wordWrap ? EditorView.lineWrapping : []) });
      },
    ),
  );

  createEffect(
    on(
      () => props.editor_font_size,
      (fontSize) => {
        if (!view) return;
        view.dispatch({ effects: font_size_compartment.reconfigure(editor_font_size_theme(fontSize)) });
      },
    ),
  );

  createEffect(
    on(
      () => props.store.current_file(),
      (file) => {
        if (!view) return;
        if (current_is_binary()) return;

        const ytext = props.store.get_ytext(file);
        const undoManager = get_undo_manager(file, ytext);

        view.setState(create_editor_state(ytext, undoManager));
        update_cursor_presence(view, false);

        if (props.vim_enabled) {
          import("@replit/codemirror-vim").then(({ vim }) => {
            if (view) view.dispatch({ effects: vim_compartment.reconfigure(vim()) });
          });
        }
      },
    ),
  );

  createEffect(() => {
    if (!view) return;
    const diags = worker_client.diagnostics();
    const current = props.store.current_file();
    const cm_diags: CmDiagnostic[] = [];
    for (const d of diags) {
      if (!d.file || !d.line) continue;
      if (d.file !== current) continue;
      const line_num = Math.max(1, Math.min(d.line, view.state.doc.lines));
      const line_obj = view.state.doc.line(line_num);
      cm_diags.push({
        from: line_obj.from,
        to: line_obj.to,
        severity: d.severity,
        message: d.message,
        source: "eztex",
      });
    }
    view.dispatch(cmSetDiagnostics(view.state, cm_diags));
  });

  createEffect(() => {
    const req = worker_client.goto_request();
    if (!req || !view) return;
    const file_matches = req.file === props.store.current_file();
    if (!file_matches) return;
    const line_num = Math.max(1, Math.min(req.line, view.state.doc.lines));
    const line_obj = view.state.doc.line(line_num);
    suppress_forward_sync = true;
    view.dispatch({
      selection: { anchor: line_obj.from },
      scrollIntoView: true,
    });
    view.focus();
    if (goto_reset_timer !== undefined) clearTimeout(goto_reset_timer);
    goto_reset_timer = setTimeout(() => { suppress_forward_sync = false; }, 400);
    worker_client.clear_goto();
  });

  createEffect(() => {
    const current_file = props.store.current_file();
    const awareness = props.store.awareness();
    if (!view || current_is_binary()) {
      awareness.setLocalStateField("cursor_file", current_file);
      awareness.setLocalStateField("cursor_line", null);
      awareness.setLocalStateField("last_active_at", Date.now());
      return;
    }
    update_cursor_presence(view, false);
  });

  onCleanup(() => {
    if (sync_timer !== undefined) clearTimeout(sync_timer);
    if (goto_reset_timer !== undefined) clearTimeout(goto_reset_timer);
    view?.destroy();
    view = undefined;
    for (const manager of undo_managers.values()) manager.destroy();
    undo_managers.clear();
  });

  return (
    <div class="editor-pane">
      <Show when={current_is_binary()}>
        <Show
          when={image_url()}
          fallback={
            <div class="binary-placeholder">
              <span class="binary-placeholder-icon">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
              </span>
              <span class="binary-placeholder-name">{props.store.current_file()}</span>
              <span class="binary-placeholder-label">Binary file -- not editable</span>
            </div>
          }
        >
          <img src={image_url()!} class="image-preview" alt={props.store.current_file()} />
        </Show>
      </Show>
      <div class="editor-cm-container" ref={container_ref} style={{ display: current_is_binary() ? "none" : undefined }} />
    </div>
  );
};

export default Editor;
