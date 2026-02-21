import { type Component, onMount, onCleanup, createEffect, on } from "solid-js";
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

type Props = {
  store: ProjectStore;
};

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

  onMount(() => {
    if (!container_ref) return;

    const state = EditorState.create({
      doc: props.store.get_content(props.store.current_file()) ?? "",
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
      () => props.store.current_file(),
      () => {
        if (!view) return;
        updating_from_outside = true;
        const content = props.store.get_content(props.store.current_file()) ?? "";
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
      <div class="editor-cm-container" ref={container_ref} />
    </div>
  );
};

export default Editor;
