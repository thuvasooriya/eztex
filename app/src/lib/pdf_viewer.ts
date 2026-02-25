// imperative PDF.js wrapper -- not reactive, controlled from SolidJS effects
import * as PDFJS from "pdfjs-dist";
import { PDFViewer, EventBus, PDFLinkService } from "pdfjs-dist/web/pdf_viewer.mjs";
import "pdfjs-dist/web/pdf_viewer.css";
import type { SyncToPdfResult } from "./synctex";

PDFJS.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.mjs",
  import.meta.url,
).href;

export class PdfViewerWrapper {
  private container: HTMLDivElement;
  private event_bus: EventBus;
  private link_service: PDFLinkService;
  private viewer: PDFViewer;
  private current_doc: PDFJS.PDFDocumentProxy | null = null;
  private highlight_el: HTMLDivElement | null = null;
  private scale_key = "eztex_pdf_scale";

  constructor(container: HTMLDivElement) {
    this.container = container;

    this.event_bus = new EventBus();
    this.link_service = new PDFLinkService({ eventBus: this.event_bus });

    const viewer_div = container.querySelector(".pdfViewer") as HTMLDivElement;
    this.viewer = new PDFViewer({
      container,
      viewer: viewer_div,
      eventBus: this.event_bus,
      linkService: this.link_service,
      removePageBorders: true,
      textLayerMode: 0, // disable text layer
      annotationMode: 0, // disable annotations
    });
    this.link_service.setViewer(this.viewer);

    // fit width on initial load and resize
    this.event_bus.on("pagesinit", () => {
      const saved = localStorage.getItem(this.scale_key);
      if (saved) {
        this.viewer.currentScaleValue = saved;
      } else {
        this.viewer.currentScaleValue = "page-width";
      }
    });

    // handle ctrl+scroll zoom
    container.addEventListener("wheel", this.handle_wheel, { passive: false });
  }

  private handle_wheel = (e: WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const delta = e.deltaY;
    if (delta < 0) {
      this.viewer.increaseScale({ steps: 1, origin: [e.clientX, e.clientY] });
    } else {
      this.viewer.decreaseScale({ steps: 1, origin: [e.clientX, e.clientY] });
    }
    localStorage.setItem(this.scale_key, String(this.viewer.currentScale));
  };

  async load_document(data: Uint8Array): Promise<void> {
    const prev_page = this.current_doc ? this.viewer.currentPageNumber : 1;
    const prev_scroll = this.container.scrollTop;

    const doc = await PDFJS.getDocument({ data: data.slice().buffer }).promise;

    if (this.current_doc) {
      this.current_doc.destroy();
    }
    this.current_doc = doc;

    this.viewer.setDocument(doc);
    this.link_service.setDocument(doc);

    // restore scroll after pages render
    this.event_bus.on("pagesloaded", () => {
      if (prev_page <= doc.numPages) {
        this.viewer.currentPageNumber = prev_page;
      }
      this.container.scrollTop = prev_scroll;
    }, { once: true } as any);
  }

  scroll_to_page(page: number): void {
    this.viewer.scrollPageIntoView({ pageNumber: page });
  }

  // forward sync: scroll to page and highlight rect
  scroll_to_and_highlight(target: SyncToPdfResult): void {
    const page_index = target.page - 1;
    const page_view = this.viewer.getPageView(page_index);
    if (!page_view?.viewport) return;

    // scroll page into view first
    this.viewer.scrollPageIntoView({ pageNumber: target.page });

    // convert synctex coords (PDF user-space, top-origin after offset) to viewport pixels
    const vp = page_view.viewport;
    const page_height = vp.viewBox[3];

    // synctex y is from top (after adding offset), PDF origin is bottom-left
    // so: pdf_bottom_y = page_height - synctex_y - synctex_height
    // and: pdf_top_y = page_height - synctex_y
    const pdf_left = target.x;
    const pdf_bottom = page_height - (target.y + target.height);
    const pdf_right = target.x + target.width;
    const pdf_top = page_height - target.y;

    const vp_rect = vp.convertToViewportRectangle([pdf_left, pdf_bottom, pdf_right, pdf_top]);
    const [left, top, right, bottom] = PDFJS.Util.normalizeRect(vp_rect);

    // position highlight overlay on the page div
    const page_div = page_view.div as HTMLDivElement;
    this.clear_highlight();

    const hl = document.createElement("div");
    hl.className = "synctex-highlight";
    hl.style.position = "absolute";
    hl.style.left = `${left}px`;
    hl.style.top = `${top}px`;
    hl.style.width = `${right - left}px`;
    hl.style.height = `${bottom - top}px`;
    page_div.style.position = "relative";
    page_div.appendChild(hl);
    this.highlight_el = hl;

    // remove after animation
    hl.addEventListener("animationend", () => this.clear_highlight(), { once: true });
  }

  private clear_highlight(): void {
    if (this.highlight_el) {
      this.highlight_el.remove();
      this.highlight_el = null;
    }
  }

  // reverse sync: click event -> {page, x, y} in synctex coords
  click_to_synctex(e: MouseEvent): { page: number; x: number; y: number } | null {
    // find which page was clicked
    const target = (e.target as HTMLElement).closest(".page") as HTMLElement | null;
    if (!target) return null;
    const page_num_str = target.getAttribute("data-page-number");
    if (!page_num_str) return null;
    const page_num = parseInt(page_num_str, 10);
    const page_index = page_num - 1;
    const page_view = this.viewer.getPageView(page_index);
    if (!page_view?.viewport) return null;

    const vp = page_view.viewport;
    const page_div = page_view.div as HTMLElement;
    const rect = page_div.getBoundingClientRect();
    const dx = e.clientX - rect.left;
    const dy = e.clientY - rect.top;

    const [pdf_x, pdf_y] = vp.convertToPdfPoint(dx, dy);
    // pdf_y is from bottom of page, convert to synctex convention (from top)
    const sync_y = vp.viewBox[3] - pdf_y;
    return { page: page_num, x: pdf_x, y: sync_y };
  }

  get page_count(): number {
    return this.current_doc?.numPages ?? 0;
  }

  destroy(): void {
    this.container.removeEventListener("wheel", this.handle_wheel);
    this.clear_highlight();
    if (this.current_doc) {
      this.current_doc.destroy();
      this.current_doc = null;
    }
  }
}
