import { type Component, onMount, onCleanup, createEffect, on, Show, createSignal, createMemo } from "solid-js";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightSpecialChars, drawSelection } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
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
import type { ProjectStore } from "../lib/project_store";
import { is_binary } from "../lib/project_store";
import { worker_client } from "../lib/worker_client";

type Props = {
  store: ProjectStore;
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

const Editor: Component<Props> = (props) => {
  let container_ref: HTMLDivElement | undefined;
  let view: EditorView | undefined;
  let updating_from_outside = false;

  const current_is_binary = () => is_binary(props.store.current_file());

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
        // revoke previous blob url
        const prev = image_url();
        if (prev) URL.revokeObjectURL(prev);
        set_image_url(null);

        if (!mime) return;
        const content = props.store.get_content(file);
        if (!(content instanceof Uint8Array)) return;
        const blob = new Blob([content.buffer as ArrayBuffer], { type: mime });
        set_image_url(URL.createObjectURL(blob));
      },
    ),
  );

  onCleanup(() => {
    const url = image_url();
    if (url) URL.revokeObjectURL(url);
  });

  // debounced forward sync: cursor position -> PDF highlight
  let sync_timer: ReturnType<typeof setTimeout> | undefined;
  // suppression flag: prevents forward sync when cursor is moved by reverse sync (goto_request)
  let suppress_forward_sync = false;

  onMount(() => {
    if (!container_ref) return;

    const state = EditorState.create({
      doc: props.store.get_text_content(props.store.current_file()) ?? "",
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightSpecialChars(),
        drawSelection(),
        bracketMatching(),
        indentOnInput(),
        foldGutter(),
        history(),
        StreamLanguage.define(stex),
        syntaxHighlighting(tokyo_night_highlight),
        tokyo_night_theme,
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !updating_from_outside) {
            props.store.update_content(
              props.store.current_file(),
              update.state.doc.toString(),
            );
          }
          // forward sync on cursor movement (selection change or doc change)
          if (update.selectionSet || update.docChanged) {
            if (sync_timer !== undefined) clearTimeout(sync_timer);
            sync_timer = setTimeout(() => {
              if (suppress_forward_sync) {
                console.debug("[synctex:forward] suppressed (triggered by reverse sync goto)");
                return;
              }
              const line = update.state.doc.lineAt(update.state.selection.main.head).number;
              console.debug("[synctex:forward] cursor debounce fired", { file: props.store.current_file(), line });
              worker_client.sync_forward(props.store.current_file(), line);
            }, 300);
          }
        }),
        EditorView.lineWrapping,
      ],
    });

    view = new EditorView({
      state,
      parent: container_ref,
    });
  });

  createEffect(
    on(
      () => [props.store.current_file(), props.store.revision()] as const,
      ([file]) => {
        if (!view) return;
        updating_from_outside = true;
        const content = current_is_binary() ? "" : (props.store.get_text_content(file) ?? "");
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: content },
        });
        updating_from_outside = false;
      },
    ),
  );

  // push external diagnostics into CodeMirror when they change
  createEffect(() => {
    if (!view) return;
    const diags = worker_client.diagnostics();
    const current = props.store.current_file();
    const cm_diags: CmDiagnostic[] = [];
    for (const d of diags) {
      if (!d.file || !d.line) continue;
      if (d.file !== current) continue;
      const line_num = Math.min(d.line, view.state.doc.lines);
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

  // jump to line when goto_request fires
  createEffect(() => {
    const req = worker_client.goto_request();
    if (!req || !view) return;
    const file_matches = req.file === props.store.current_file();
    if (!file_matches) return;
    console.debug("[synctex:reverse] goto_request effect", { file: req.file, line: req.line });
    const line_num = Math.min(req.line, view.state.doc.lines);
    const line_obj = view.state.doc.line(line_num);
    // suppress forward sync so dispatching the cursor change doesn't trigger
    // a feedback loop: reverse sync -> cursor move -> forward sync -> highlight
    suppress_forward_sync = true;
    view.dispatch({
      selection: { anchor: line_obj.from },
      scrollIntoView: true,
    });
    view.focus();
    // clear suppression after the debounce window (300ms) plus a small margin
    setTimeout(() => { suppress_forward_sync = false; }, 400);
    // clear after consuming so stale state doesn't accumulate
    worker_client.clear_goto();
  });

  onCleanup(() => {
    if (sync_timer !== undefined) clearTimeout(sync_timer);
    view?.destroy();
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
