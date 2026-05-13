import { autocompletion, snippetCompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";

const BASE_COMMANDS: Completion[] = [
  snippetCompletion("documentclass{${}}", { label: "\\documentclass", type: "keyword", detail: "LaTeX class" }),
  snippetCompletion("usepackage{${}}", { label: "\\usepackage", type: "keyword", detail: "Load package" }),
  snippetCompletion("section{${}}", { label: "\\section", type: "function" }),
  snippetCompletion("subsection{${}}", { label: "\\subsection", type: "function" }),
  snippetCompletion("subsubsection{${}}", { label: "\\subsubsection", type: "function" }),
  snippetCompletion("textbf{${}}", { label: "\\textbf", type: "function" }),
  snippetCompletion("textit{${}}", { label: "\\textit", type: "function" }),
  snippetCompletion("emph{${}}", { label: "\\emph", type: "function" }),
  snippetCompletion("includegraphics{${}}", { label: "\\includegraphics", type: "function" }),
  snippetCompletion("label{${}}", { label: "\\label", type: "function" }),
  snippetCompletion("ref{${}}", { label: "\\ref", type: "function" }),
  snippetCompletion("cite{${}}", { label: "\\cite", type: "function" }),
  snippetCompletion("item ", { label: "\\item", type: "keyword" }),
  snippetCompletion("frac{${}}{${}}", { label: "\\frac", type: "function", detail: "fraction" }),
  snippetCompletion("sqrt{${}}", { label: "\\sqrt", type: "function" }),
  snippetCompletion("begin{equation}\n\t${}\n\\end{equation}", { label: "\\begin{equation}", type: "snippet" }),
  snippetCompletion("begin{align}\n\t${}\n\\end{align}", { label: "\\begin{align}", type: "snippet" }),
  snippetCompletion("begin{itemize}\n\t\\item ${}\n\\end{itemize}", { label: "\\begin{itemize}", type: "snippet" }),
  snippetCompletion("begin{enumerate}\n\t\\item ${}\n\\end{enumerate}", { label: "\\begin{enumerate}", type: "snippet" }),
  snippetCompletion("begin{figure}\n\t\\centering\n\t\\includegraphics[width=0.8\\linewidth]{${}}\n\t\\caption{}\n\\end{figure}", { label: "\\begin{figure}", type: "snippet" }),
];

const AMS_COMMANDS: Completion[] = [
  snippetCompletion("mathbb{${}}", { label: "\\mathbb", type: "function", detail: "amsmath/amssymb" }),
  snippetCompletion("mathcal{${}}", { label: "\\mathcal", type: "function", detail: "amsmath" }),
  snippetCompletion("operatorname{${}}", { label: "\\operatorname", type: "function", detail: "amsmath" }),
  snippetCompletion("dfrac{${}}{${}}", { label: "\\dfrac", type: "function", detail: "amsmath" }),
  snippetCompletion("tfrac{${}}{${}}", { label: "\\tfrac", type: "function", detail: "amsmath" }),
  snippetCompletion("begin{cases}\n\t${} & \\\n\\end{cases}", { label: "\\begin{cases}", type: "snippet", detail: "amsmath" }),
  snippetCompletion("begin{pmatrix}\n\t${}\n\\end{pmatrix}", { label: "\\begin{pmatrix}", type: "snippet", detail: "amsmath" }),
];

const ENVIRONMENTS = [
  "document", "abstract", "equation", "align", "itemize", "enumerate", "figure", "table", "center", "quote", "verbatim", "tabular", "minipage", "theorem", "proof", "cases", "pmatrix", "bmatrix",
];

function has_amsmath(doc: string): boolean {
  return /\\usepackage(?:\[[^\]]*\])?\{[^}]*\b(?:amsmath|amssymb|mathtools)\b[^}]*\}/.test(doc);
}

function latex_completion_source(context: CompletionContext): CompletionResult | null {
  const begin = context.matchBefore(/\\begin\{[^}\\]*/);
  if (begin) {
    return {
      from: begin.from + "\\begin{".length,
      options: ENVIRONMENTS.map((env) => ({ label: env, type: "namespace", apply: env })),
      validFor: /^[\w*]*$/,
    };
  }

  const command = context.matchBefore(/\\[A-Za-z]*/);
  if (!command || (command.from === command.to && !context.explicit)) return null;
  const doc = context.state.doc.toString();
  return {
    from: command.from + 1,
    options: has_amsmath(doc) ? BASE_COMMANDS.concat(AMS_COMMANDS) : BASE_COMMANDS,
    validFor: /^[A-Za-z]*$/,
  };
}

export function latex_autocomplete() {
  return autocompletion({ override: [latex_completion_source], activateOnTyping: true });
}
