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
import type { ProjectStore } from "../lib/project_store";
import { is_binary } from "../lib/project_store";

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
});

const tokyo_night_highlight = HighlightStyle.define([
  { tag: tags.keyword, color: "#bb9af7" },
  { tag: tags.comment, color: "#565f89", fontStyle: "italic" },
  { tag: tags.string, color: "#9ece6a" },
  { tag: tags.number, color: "#ff9e64" },
  { tag: tags.operator, color: "#7dcfff" },
  { tag: tags.meta, color: "#e0af68" },
  { tag: tags.bracket, color: "#a9b1d6" },
  { tag: tags.tagName, color: "#f7768e" },
  { tag: tags.attributeName, color: "#e0af68" },
  { tag: tags.attributeValue, color: "#9ece6a" },
  { tag: tags.definition(tags.variableName), color: "#7aa2f7" },
  { tag: tags.atom, color: "#ff9e64" },
  { tag: tags.typeName, color: "#7dcfff" },
  { tag: tags.className, color: "#7dcfff" },
  { tag: tags.propertyName, color: "#7aa2f7" },
  { tag: tags.variableName, color: "#c0caf5" },
  { tag: tags.bool, color: "#ff9e64" },
  { tag: tags.null, color: "#ff9e64" },
  { tag: tags.processingInstruction, color: "#7aa2f7" },
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

  onCleanup(() => {
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
