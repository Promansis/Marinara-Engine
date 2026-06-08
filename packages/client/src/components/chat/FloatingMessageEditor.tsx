import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { Check, Eye, GripHorizontal, ListChecks, List, Pencil, X } from "lucide-react";
import { cn } from "../../lib/utils";
import { applyInlineMarkdown, renderMarkdownBlocks } from "../../lib/markdown";

interface FloatingMessageEditorProps {
  open: boolean;
  title: string;
  initialContent: string;
  fontSize?: string | number;
  normalizeQuotes?: boolean;
  showFormatting?: boolean;
  onSave: (content: string) => void;
  onCancel: () => void;
}

interface PanelLayout {
  x: number;
  y: number;
  width: number;
  height: number;
}

const DEFAULT_WIDTH = 560;
const DEFAULT_HEIGHT = 420;
const MIN_WIDTH = 280;
const MIN_HEIGHT = 260;
const VIEWPORT_MARGIN = 12;

function quoteNormalized(value: string): string {
  return value.replace(/[\u201C\u201D\u201E\u201F]/g, '"').replace(/[\u2018\u2019]/g, "'");
}

function getTextareaValue(textarea: HTMLTextAreaElement) {
  return textarea.value;
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string, selectionStart: number, selectionEnd = selectionStart) {
  textarea.value = value;
  textarea.focus();
  textarea.setSelectionRange(selectionStart, selectionEnd);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function getDefaultLayout(): PanelLayout {
  if (typeof window === "undefined") {
    return { x: VIEWPORT_MARGIN, y: VIEWPORT_MARGIN, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
  }
  const maxWidth = Math.max(MIN_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2);
  const maxHeight = Math.max(MIN_HEIGHT, window.innerHeight - VIEWPORT_MARGIN * 2);
  const width = Math.min(DEFAULT_WIDTH, maxWidth);
  const height = Math.min(DEFAULT_HEIGHT, maxHeight);
  return {
    x: Math.max(VIEWPORT_MARGIN, Math.round((window.innerWidth - width) / 2)),
    y: Math.max(VIEWPORT_MARGIN, Math.round((window.innerHeight - height) / 2)),
    width,
    height,
  };
}

function constrainLayout(layout: PanelLayout): PanelLayout {
  if (typeof window === "undefined") return layout;
  const maxWidth = Math.max(MIN_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2);
  const maxHeight = Math.max(MIN_HEIGHT, window.innerHeight - VIEWPORT_MARGIN * 2);
  const width = Math.min(Math.max(layout.width, MIN_WIDTH), maxWidth);
  const height = Math.min(Math.max(layout.height, MIN_HEIGHT), maxHeight);
  const maxX = Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN);
  const maxY = Math.max(VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN);
  return {
    x: Math.min(Math.max(layout.x, VIEWPORT_MARGIN), maxX),
    y: Math.min(Math.max(layout.y, VIEWPORT_MARGIN), maxY),
    width,
    height,
  };
}

export const FloatingMessageEditor = memo(function FloatingMessageEditor({
  open,
  title,
  initialContent,
  fontSize,
  normalizeQuotes = false,
  showFormatting = false,
  onSave,
  onCancel,
}: FloatingMessageEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; layout: PanelLayout } | null>(null);
  const resizeRef = useRef<{ pointerId: number; startX: number; startY: number; layout: PanelLayout } | null>(null);
  const [layout, setLayout] = useState<PanelLayout>(() => getDefaultLayout());
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [previewMode, setPreviewMode] = useState(false);
  const [editorContent, setEditorContent] = useState(initialContent);

  useEffect(() => {
    if (!open) return;
    const nextContent = normalizeQuotes ? quoteNormalized(initialContent) : initialContent;
    setPreviewMode(false);
    setEditorContent(nextContent);
    setLayout((current) => constrainLayout(current));
    requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }));
  }, [initialContent, normalizeQuotes, open]);

  useEffect(() => {
    if (!open) return;
    const handleResize = () => setLayout((current) => constrainLayout(current));
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [open]);

  const panelStyle = useMemo<CSSProperties>(
    () => ({
      left: layout.x,
      top: layout.y,
      width: layout.width,
      height: layout.height,
      borderColor: "var(--border)",
    }),
    [layout],
  );

  const headerStyle = useMemo<CSSProperties>(
    () => ({
      borderBottomColor: "color-mix(in srgb, var(--primary) 18%, var(--border))",
      background:
        "linear-gradient(118deg, color-mix(in srgb, var(--primary) 10%, transparent), transparent 34%), linear-gradient(180deg, color-mix(in srgb, var(--secondary) 54%, var(--card)), var(--card))",
    }),
    [],
  );

  const handleSave = useCallback(() => {
    onSave(textareaRef.current?.value ?? editorContent);
  }, [editorContent, onSave]);

  const insertTextFormat = useCallback((before: string, after = before) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? start;
    const value = getTextareaValue(textarea);
    const selected = value.slice(start, end);
    const insert = `${before}${selected}${after}`;
    setTextareaValue(textarea, `${value.slice(0, start)}${insert}${value.slice(end)}`, start + before.length, start + before.length + selected.length);
    setEditorContent(textarea.value);
  }, []);

  const applyLineFormat = useCallback((marker: string) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? start;
    const value = getTextareaValue(textarea);
    const lineStart = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
    const lineEndIndex = value.indexOf("\n", end);
    const lineEnd = lineEndIndex === -1 ? value.length : lineEndIndex;
    const block = value.slice(lineStart, lineEnd);
    const lines = block.split("\n");
    const next = lines
      .map((line) => {
        if (!line.trim()) return `${marker}`;
        if (/^\s*[-*]\s+/.test(line)) return line;
        return `${marker}${line}`;
      })
      .join("\n");
    setTextareaValue(textarea, `${value.slice(0, lineStart)}${next}${value.slice(lineEnd)}`, lineStart, lineStart + next.length);
    setEditorContent(textarea.value);
  }, []);

  const startDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      const target = event.target as HTMLElement;
      if (target.closest("button, textarea")) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, layout };
      setIsDragging(true);
    },
    [layout],
  );

  const moveDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setLayout(
      constrainLayout({
        ...drag.layout,
        x: drag.layout.x + event.clientX - drag.startX,
        y: drag.layout.y + event.clientY - drag.startY,
      }),
    );
  }, []);

  const endDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setIsDragging(false);
  }, []);

  const startResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      resizeRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, layout };
      setIsResizing(true);
    },
    [layout],
  );

  const moveResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    setLayout(
      constrainLayout({
        ...resize.layout,
        width: resize.layout.width + event.clientX - resize.startX,
        height: resize.layout.height + event.clientY - resize.startY,
      }),
    );
  }, []);

  const endResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    resizeRef.current = null;
    setIsResizing(false);
  }, []);

  if (!open) return null;

  return createPortal(
    <div className="pointer-events-none fixed inset-0 z-[9998]" data-no-message-quick-edit>
      <section
        aria-label={title}
        className={cn(
          "pointer-events-auto fixed flex min-w-0 flex-col overflow-hidden rounded-xl border bg-[var(--card)] text-[var(--foreground)] shadow-[0_1rem_3rem_rgb(0_0_0/0.42)]",
          (isDragging || isResizing) && "select-none",
        )}
        style={panelStyle}
      >
        <header
          className={cn(
            "relative z-10 flex cursor-grab select-none items-center justify-between gap-2 border-b px-2 py-1.5",
            isDragging && "cursor-grabbing",
          )}
          style={headerStyle}
          title="Drag editor"
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel edit"
            title="Cancel"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] transition-colors hover:bg-[var(--secondary)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]/45"
          >
            <X size="0.95rem" />
          </button>
          <div className="flex min-w-0 flex-1 items-center justify-center gap-2 text-[0.8125rem] font-semibold">
            <GripHorizontal size="0.95rem" className="shrink-0 text-[var(--primary)]/80" aria-hidden="true" />
            <span className="truncate">{title}</span>
          </div>
          <button
            type="button"
            onClick={handleSave}
            aria-label="Save edit"
            title="Save"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--primary)] text-[var(--primary-foreground)] transition-colors hover:bg-[var(--primary)]/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]/45"
          >
            <Check size="0.95rem" />
          </button>
        </header>
        {showFormatting && (
          <div className="flex items-center justify-between gap-1 border-b border-[var(--border)]/70 bg-[color-mix(in_srgb,var(--card)_82%,var(--background))] px-2 py-1">
            <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
              <button type="button" onClick={() => insertTextFormat("**")} disabled={previewMode} title="Bold selected text" className="inline-flex min-h-5 min-w-6 items-center justify-center rounded-md border border-[var(--border)]/70 bg-[var(--secondary)]/35 px-1.5 text-[0.625rem] font-black text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)] disabled:opacity-40">
                B
              </button>
              <button type="button" onClick={() => insertTextFormat("*")} disabled={previewMode} title="Italicize selected text" className="inline-flex min-h-5 min-w-6 items-center justify-center rounded-md border border-[var(--border)]/70 bg-[var(--secondary)]/35 px-1.5 text-[0.625rem] font-bold italic text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)] disabled:opacity-40">
                I
              </button>
              <button type="button" onClick={() => insertTextFormat("__")} disabled={previewMode} title="Underline selected text" className="inline-flex min-h-5 min-w-6 items-center justify-center rounded-md border border-[var(--border)]/70 bg-[var(--secondary)]/35 px-1.5 text-[0.625rem] font-bold text-[var(--muted-foreground)] underline underline-offset-2 hover:bg-[var(--secondary)] hover:text-[var(--foreground)] disabled:opacity-40">
                U
              </button>
              <button type="button" onClick={() => insertTextFormat("~~")} disabled={previewMode} title="Strikethrough selected text" className="inline-flex min-h-5 min-w-6 items-center justify-center rounded-md border border-[var(--border)]/70 bg-[var(--secondary)]/35 px-1.5 text-[0.625rem] font-bold text-[var(--muted-foreground)] line-through hover:bg-[var(--secondary)] hover:text-[var(--foreground)] disabled:opacity-40">
                S
              </button>
              <button type="button" onClick={() => applyLineFormat("- ")} disabled={previewMode} title="Add bullet list item" className="inline-flex min-h-5 min-w-6 items-center justify-center rounded-md border border-[var(--border)]/70 bg-[var(--secondary)]/35 text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)] disabled:opacity-40">
                <List size="0.75rem" />
              </button>
              <button type="button" onClick={() => applyLineFormat("- [ ] ")} disabled={previewMode} title="Add checklist item" className="inline-flex min-h-5 min-w-6 items-center justify-center rounded-md border border-[var(--border)]/70 bg-[var(--secondary)]/35 text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)] disabled:opacity-40">
                <ListChecks size="0.75rem" />
              </button>
            </div>
            <button
              type="button"
              onClick={() => {
                const nextPreviewMode = !previewMode;
                if (nextPreviewMode) setEditorContent(textareaRef.current?.value ?? editorContent);
                setPreviewMode(nextPreviewMode);
              }}
              title={previewMode ? "Preview mode. Switch to edit" : "Edit mode. Switch to preview"}
              aria-pressed={previewMode}
              className="inline-flex min-h-5 min-w-12 items-center justify-center gap-1 rounded-full border border-[color-mix(in_srgb,var(--primary)_38%,var(--border))] bg-[var(--secondary)]/45 px-1.5 text-[var(--muted-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]"
            >
              <Pencil size="0.7rem" className={cn(!previewMode && "text-[var(--foreground)]")} />
              <Eye size="0.7rem" className={cn(previewMode && "text-[var(--foreground)]")} />
            </button>
          </div>
        )}
        {previewMode ? (
          <div className="min-h-0 flex-1 overflow-y-auto bg-[var(--background)] p-3 text-[var(--foreground)]" style={{ fontSize, lineHeight: 1.5 }}>
            {renderMarkdownBlocks(editorContent, applyInlineMarkdown, "floating-editor-preview")}
          </div>
        ) : (
          <textarea
            ref={textareaRef}
            value={editorContent}
            spellCheck
            className="min-h-0 flex-1 resize-none border-0 bg-[var(--background)] p-3 text-[var(--foreground)] outline-none focus:shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--primary)_28%,transparent)]"
            style={{ fontSize, lineHeight: 1.5 }}
            onChange={(event) => setEditorContent(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onCancel();
              }
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                handleSave();
              }
            }}
          />
        )}
        <div
          aria-hidden="true"
          title="Resize editor"
          className="absolute bottom-0 right-0 z-20 h-5 w-5 cursor-nwse-resize opacity-70 transition-opacity hover:opacity-100"
          onPointerDown={startResize}
          onPointerMove={moveResize}
          onPointerUp={endResize}
          onPointerCancel={endResize}
        >
          <span className="absolute bottom-1 right-1 h-3 w-3 rounded-br-md border-b-2 border-r-2 border-[var(--primary)]/45" />
        </div>
      </section>
    </div>,
    document.body,
  );
});
