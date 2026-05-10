import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Cloud,
  CloudDownload,
  CloudOff,
  CloudUpload,
  Copy,
  Download,
  ImageIcon,
  Link2,
  Loader2,
  Maximize2,
  Palette,
  RotateCcw,
  Ruler,
  Search,
  Sparkles,
  Trash2,
  X,
  XCircle
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import {
  SIZE_PRESETS,
  STYLE_PRESETS,
  type AssetCloudActionResponse,
  type AssetCloudStatusResponse,
  type GalleryImageItem,
  type GalleryResponse,
  type GeneratedAssetCloudInfo
} from "@gpt-image-canvas/shared";
import { localizedApiErrorMessage, useI18n, type Locale, type Translate } from "../../shared/i18n";
import { assetDownloadUrl, assetPreviewUrl } from "../../shared/api/assets";

interface GalleryPageProps {
  onDeleted: (outputId: string) => void;
  onReuse: (item: GalleryImageItem) => void;
}

interface GalleryActionHandlers {
  onCopy: (item: GalleryImageItem) => void;
  onDelete: (item: GalleryImageItem) => void;
  onDownload: (item: GalleryImageItem) => void;
  onReuse: (item: GalleryImageItem) => void;
  onCopyCloudLink: (item: GalleryImageItem) => void;
  onRestoreCloud: (item: GalleryImageItem) => void;
  onResyncCloud: (item: GalleryImageItem) => void;
  pendingCloudAssetId: string | null;
  cloudByAssetId: Record<string, AssetCloudStatusResponse>;
}

export function GalleryPage({ onDeleted, onReuse }: GalleryPageProps) {
  const { locale, t } = useI18n();
  const [items, setItems] = useState<GalleryImageItem[]>([]);
  const [query, setQuery] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const [expandedPrompts, setExpandedPrompts] = useState<Record<string, boolean>>({});
  const [selectedItem, setSelectedItem] = useState<GalleryImageItem | null>(null);
  const [pendingDeleteItem, setPendingDeleteItem] = useState<GalleryImageItem | null>(null);
  const [deletingOutputId, setDeletingOutputId] = useState<string | null>(null);
  const [pendingCloudAssetId, setPendingCloudAssetId] = useState<string | null>(null);
  const [cloudByAssetId, setCloudByAssetId] = useState<Record<string, AssetCloudStatusResponse>>({});
  const [copiedOutputId, setCopiedOutputId] = useState<string | null>(null);
  const statusTimerRef = useRef<number | undefined>();
  const copiedTimerRef = useRef<number | undefined>();

  useEffect(() => {
    const controller = new AbortController();

    async function loadGallery(): Promise<void> {
      setIsLoading(true);
      setError("");

      try {
        const response = await fetch("/api/gallery", {
          signal: controller.signal
        });
        if (!response.ok) {
          throw new Error(await readGalleryError(response, locale, t));
        }

        const body = (await response.json()) as GalleryResponse;
        if (!Array.isArray(body.items)) {
          throw new Error(t("galleryServiceInvalidData"));
        }

        if (!controller.signal.aborted) {
          setItems(body.items);
          setCloudByAssetId(initialCloudStatusByAssetId(body.items));
          void refreshCloudStatuses(body.items, controller.signal);
        }
      } catch (loadError) {
        if (!controller.signal.aborted) {
          setError(loadError instanceof Error ? loadError.message : t("galleryLoadFailed"));
        }
      } finally {
        if (!controller.signal.aborted) {
          setIsLoading(false);
        }
      }
    }

    void loadGallery();

    return () => {
      controller.abort();
    };
  }, [locale, t]);

  useEffect(() => {
    if (!selectedItem && !pendingDeleteItem) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") {
        return;
      }

      event.preventDefault();
      if (pendingDeleteItem) {
        setPendingDeleteItem(null);
        return;
      }

      setSelectedItem(null);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [pendingDeleteItem, selectedItem]);

  useEffect(() => {
    return () => {
      window.clearTimeout(statusTimerRef.current);
      window.clearTimeout(copiedTimerRef.current);
    };
  }, []);

  const filteredItems = useMemo(() => {
    const normalizedQuery = normalizeSearchText(query);
    if (!normalizedQuery) {
      return items;
    }

    return items.filter((item) => normalizeSearchText(item.prompt).includes(normalizedQuery));
  }, [items, query]);
  const featuredItem = filteredItems[0] ?? null;
  const gridItems = featuredItem ? filteredItems.slice(1) : filteredItems;
  const actionHandlers: GalleryActionHandlers = {
    onCopy: (item) => void copyPrompt(item),
    onCopyCloudLink: (item) => void copyCloudLink(item),
    onDelete: requestDelete,
    onDownload: downloadItem,
    onRestoreCloud: (item) => void restoreCloud(item),
    onResyncCloud: (item) => void resyncCloud(item),
    onReuse,
    pendingCloudAssetId,
    cloudByAssetId
  };

  function showStatus(message: string): void {
    window.clearTimeout(statusTimerRef.current);
    setError("");
    setStatusMessage(message);
    statusTimerRef.current = window.setTimeout(() => {
      setStatusMessage("");
    }, 3200);
  }

  function togglePrompt(outputId: string): void {
    setExpandedPrompts((current) => ({
      ...current,
      [outputId]: !current[outputId]
    }));
  }

  async function copyPrompt(item: GalleryImageItem): Promise<void> {
    try {
      await writeClipboardText(item.prompt);
      window.clearTimeout(copiedTimerRef.current);
      setCopiedOutputId(item.outputId);
      copiedTimerRef.current = window.setTimeout(() => {
        setCopiedOutputId((current) => (current === item.outputId ? null : current));
        copiedTimerRef.current = undefined;
      }, 1800);
      showStatus(t("galleryCopiedPrompt"));
    } catch {
      setError(t("generationCopyFailed"));
    }
  }

  async function refreshCloudStatuses(galleryItems: GalleryImageItem[], signal: AbortSignal): Promise<void> {
    const cloudItems = galleryItems.filter((item) => item.asset.cloud);
    await Promise.all(
      cloudItems.map(async (item) => {
        try {
          const response = await fetch(`/api/assets/${encodeURIComponent(item.asset.id)}/cloud`, { signal });
          if (!response.ok) {
            return;
          }

          const cloud = (await response.json()) as AssetCloudStatusResponse;
          if (!signal.aborted) {
            applyCloudStatus(item.asset.id, cloud);
          }
        } catch {
          // Gallery remains usable with the stored cloud summary.
        }
      })
    );
  }

  async function resyncCloud(item: GalleryImageItem): Promise<void> {
    await runCloudAction(item, "resync", t("galleryCloudResynced"));
  }

  async function restoreCloud(item: GalleryImageItem): Promise<void> {
    await runCloudAction(item, "restore", t("galleryCloudRestored"));
  }

  async function copyCloudLink(item: GalleryImageItem): Promise<void> {
    const existing = cloudByAssetId[item.asset.id];
    let cloud = existing?.publicUrl ? existing : undefined;

    if (!cloud) {
      cloud = await runCloudAction(item, "refresh-url");
    }
    if (!cloud?.publicUrl) {
      setError(t("galleryRequestFailed", { status: 400 }));
      return;
    }

    try {
      await writeClipboardText(cloud.publicUrl);
      showStatus(t("galleryCloudLinkCopied"));
    } catch {
      setError(t("generationCopyFailed"));
    }
  }

  async function runCloudAction(
    item: GalleryImageItem,
    action: "resync" | "restore" | "refresh-url",
    successMessage?: string
  ): Promise<AssetCloudStatusResponse | undefined> {
    setPendingCloudAssetId(item.asset.id);
    setError("");

    try {
      const response = await fetch(`/api/assets/${encodeURIComponent(item.asset.id)}/cloud/${action}`, {
        method: "POST"
      });
      if (!response.ok) {
        throw new Error(await readGalleryError(response, locale, t));
      }

      const body = (await response.json()) as AssetCloudActionResponse;
      applyCloudStatus(item.asset.id, body.cloud);
      if (successMessage) {
        showStatus(successMessage);
      }
      return body.cloud;
    } catch (cloudError) {
      setError(cloudError instanceof Error ? cloudError.message : t("galleryLoadFailed"));
      return undefined;
    } finally {
      setPendingCloudAssetId(null);
    }
  }

  function applyCloudStatus(assetId: string, cloud: AssetCloudStatusResponse): void {
    setCloudByAssetId((current) => ({
      ...current,
      [assetId]: cloud
    }));
    setItems((current) =>
      current.map((item) =>
        item.asset.id === assetId
          ? {
              ...item,
              asset: {
                ...item.asset,
                cloud: toGeneratedAssetCloud(cloud)
              }
            }
          : item
      )
    );
    setSelectedItem((current) =>
      current?.asset.id === assetId
        ? {
            ...current,
            asset: {
              ...current.asset,
              cloud: toGeneratedAssetCloud(cloud)
            }
          }
        : current
    );
  }

  function downloadItem(item: GalleryImageItem): void {
    window.open(assetDownloadUrl(item.asset.id), "_blank", "noopener,noreferrer");
    showStatus(t("galleryOpenDownload"));
  }

  function downloadGalleryZip(): void {
    window.open("/api/gallery/export.zip", "_blank", "noopener,noreferrer");
    showStatus(t("galleryExportStarted"));
  }

  function requestDelete(item: GalleryImageItem): void {
    setError("");
    setPendingDeleteItem(item);
  }

  async function deleteItem(item: GalleryImageItem): Promise<void> {
    setDeletingOutputId(item.outputId);
    setError("");

    try {
      const response = await fetch(`/api/gallery/${encodeURIComponent(item.outputId)}`, {
        method: "DELETE"
      });
      if (!response.ok) {
        throw new Error(await readGalleryError(response, locale, t));
      }

      setItems((current) => current.filter((galleryItem) => galleryItem.outputId !== item.outputId));
      setSelectedItem((current) => (current?.outputId === item.outputId ? null : current));
      setCopiedOutputId((current) => (current === item.outputId ? null : current));
      setPendingDeleteItem(null);
      onDeleted(item.outputId);
      showStatus(t("galleryDeleted"));
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : t("galleryDeleteFailed"));
    } finally {
      setDeletingOutputId(null);
    }
  }

  return (
    <main className="gallery-page app-view" data-testid="gallery-page">
      <div className="gallery-page__inner">
        <header className="gallery-header">
          <div className="gallery-header__copy">
            <p className="gallery-kicker">
              <Sparkles className="size-3.5" aria-hidden="true" />
              {t("galleryKicker")}
            </p>
            <h1>{t("galleryTitle")}</h1>
          </div>
          <div className="gallery-header__meta" aria-label={t("galleryHeaderMeta", { count: items.length })}>
            <strong>{items.length}</strong>
            <span>{t("galleryWorkCount")}</span>
            <span>{t("galleryWorkSort")}</span>
          </div>
          <div className="gallery-search" role="search">
            <Search className="size-4" aria-hidden="true" />
            <input
              aria-label={t("gallerySearchAria")}
              className="gallery-search__input"
              data-testid="gallery-search"
              id="gallery-search-input"
              name="gallery-search"
              placeholder={t("gallerySearchPlaceholder")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <button className="secondary-action h-10" type="button" onClick={downloadGalleryZip}>
            <Download className="size-4" aria-hidden="true" />
            {t("galleryExportZip")}
          </button>
        </header>

        {error ? (
          <div className="gallery-alert gallery-alert--error" data-testid="gallery-error" role="alert">
            <XCircle className="size-4 shrink-0" aria-hidden="true" />
            <p>{error}</p>
          </div>
        ) : null}
        {statusMessage ? (
          <div className="gallery-alert gallery-alert--success" data-testid="gallery-message" role="status">
            <ImageIcon className="size-4 shrink-0" aria-hidden="true" />
            <p>{statusMessage}</p>
          </div>
        ) : null}

        {isLoading ? (
          <div className="gallery-empty-state" data-testid="gallery-loading" role="status">
            <Loader2 className="size-5 animate-spin" aria-hidden="true" />
            <p>{t("galleryLoading")}</p>
          </div>
        ) : filteredItems.length === 0 ? (
          <div className="gallery-empty-state" data-testid="gallery-empty">
            <ImageIcon className="size-7" aria-hidden="true" />
            <div>
              <p>{items.length === 0 ? t("galleryEmpty") : t("galleryNoMatches")}</p>
              <span>{items.length === 0 ? t("galleryEmptyHint") : t("galleryNoMatchesHint")}</span>
            </div>
          </div>
        ) : (
          <>
            {featuredItem ? (
              <FeaturedGalleryItem
                copied={copiedOutputId === featuredItem.outputId}
                deleting={deletingOutputId === featuredItem.outputId}
                expanded={Boolean(expandedPrompts[featuredItem.outputId])}
                item={featuredItem}
                onOpen={setSelectedItem}
                onTogglePrompt={togglePrompt}
                {...actionHandlers}
              />
            ) : null}

            {gridItems.length > 0 ? (
              <div className="gallery-grid" data-testid="gallery-grid">
                {gridItems.map((item) => (
                  <GalleryCard
                    copied={copiedOutputId === item.outputId}
                    deleting={deletingOutputId === item.outputId}
                    expanded={Boolean(expandedPrompts[item.outputId])}
                    item={item}
                    key={item.outputId}
                    onOpen={setSelectedItem}
                    onTogglePrompt={togglePrompt}
                    {...actionHandlers}
                  />
                ))}
              </div>
            ) : null}
          </>
        )}
      </div>

      {selectedItem ? (
        <GalleryDetailDialog
          copied={copiedOutputId === selectedItem.outputId}
          cloud={cloudByAssetId[selectedItem.asset.id]}
          deleting={deletingOutputId === selectedItem.outputId}
          item={selectedItem}
          pendingCloud={pendingCloudAssetId === selectedItem.asset.id}
          onClose={() => setSelectedItem(null)}
          onCopyCloudLink={() => void copyCloudLink(selectedItem)}
          onCopy={() => void copyPrompt(selectedItem)}
          onDelete={() => requestDelete(selectedItem)}
          onDownload={() => downloadItem(selectedItem)}
          onRestoreCloud={() => void restoreCloud(selectedItem)}
          onResyncCloud={() => void resyncCloud(selectedItem)}
          onReuse={() => onReuse(selectedItem)}
        />
      ) : null}

      {pendingDeleteItem ? (
        <DeleteGalleryDialog
          deleting={deletingOutputId === pendingDeleteItem.outputId}
          item={pendingDeleteItem}
          onCancel={() => setPendingDeleteItem(null)}
          onConfirm={() => void deleteItem(pendingDeleteItem)}
        />
      ) : null}
    </main>
  );
}

function FeaturedGalleryItem({
  copied,
  deleting,
  expanded,
  item,
  onCopy,
  onCopyCloudLink,
  onDelete,
  onDownload,
  onOpen,
  onRestoreCloud,
  onResyncCloud,
  onReuse,
  onTogglePrompt,
  pendingCloudAssetId,
  cloudByAssetId
}: {
  copied: boolean;
  deleting: boolean;
  expanded: boolean;
  item: GalleryImageItem;
  onOpen: (item: GalleryImageItem) => void;
  onTogglePrompt: (outputId: string) => void;
} & GalleryActionHandlers) {
  const { formatDateTime, t } = useI18n();

  return (
    <article className="gallery-feature" data-testid="gallery-feature">
      <button
        aria-label={t("galleryActionOpenLatest", { excerpt: promptExcerpt(item.prompt) })}
        className="gallery-feature__image-button"
        type="button"
        onClick={() => onOpen(item)}
      >
        <img
          alt={item.prompt}
          className="gallery-feature__image"
          height={item.asset.height}
          src={assetPreviewUrl(item.asset.id, 1024)}
          width={item.asset.width}
        />
        <span className="gallery-feature__badge">{t("galleryBadgeLatest")}</span>
        <span className="gallery-card__zoom">
          <Maximize2 className="size-4" aria-hidden="true" />
        </span>
      </button>

      <div className="gallery-feature__body">
        <GalleryTags item={item} />
        <CloudStatusPanel
          cloud={cloudByAssetId[item.asset.id]}
          item={item}
          pending={pendingCloudAssetId === item.asset.id}
          onCopyCloudLink={onCopyCloudLink}
          onRestoreCloud={onRestoreCloud}
          onResyncCloud={onResyncCloud}
        />
        <div className="gallery-feature__prompt-panel">
          <CollapsiblePrompt
            expanded={expanded}
            label={t("galleryPromptLabel")}
            lines={4}
            text={item.prompt}
            onToggle={() => onTogglePrompt(item.outputId)}
          />
        </div>
        <div className="gallery-feature__footer">
          <div className="gallery-feature__meta">
            <span>
              <Clock3 className="size-3.5" aria-hidden="true" />
              {formatCreatedTime(item.createdAt, formatDateTime)}
            </span>
            <span>{item.outputFormat.toUpperCase()}</span>
            <span>{t("qualityLabel", { quality: item.quality })}</span>
          </div>
          <GalleryIconActions
            copied={copied}
            deleting={deleting}
            item={item}
            onCopy={onCopy}
            onDelete={onDelete}
            onDownload={onDownload}
            onReuse={onReuse}
          />
        </div>
      </div>
    </article>
  );
}

function GalleryCard({
  copied,
  deleting,
  expanded,
  item,
  onCopy,
  onCopyCloudLink,
  onDelete,
  onDownload,
  onOpen,
  onRestoreCloud,
  onResyncCloud,
  onReuse,
  onTogglePrompt,
  pendingCloudAssetId,
  cloudByAssetId
}: {
  copied: boolean;
  deleting: boolean;
  expanded: boolean;
  item: GalleryImageItem;
  onOpen: (item: GalleryImageItem) => void;
  onTogglePrompt: (outputId: string) => void;
} & GalleryActionHandlers) {
  const { formatDateTime, t } = useI18n();

  return (
    <article className="gallery-card" data-testid="gallery-card">
      <button
        aria-label={t("galleryActionOpenImage", { excerpt: promptExcerpt(item.prompt) })}
        className="gallery-card__image-button"
        type="button"
        onClick={() => onOpen(item)}
      >
        <img
          alt={item.prompt}
          className="gallery-card__image"
          height={item.asset.height}
          loading="lazy"
          src={assetPreviewUrl(item.asset.id, 512)}
          width={item.asset.width}
        />
        <span className="gallery-card__zoom">
          <Maximize2 className="size-4" aria-hidden="true" />
        </span>
      </button>

      <div className="gallery-card__body">
        <GalleryTags item={item} compact />
        <CloudStatusPanel
          cloud={cloudByAssetId[item.asset.id]}
          compact
          item={item}
          pending={pendingCloudAssetId === item.asset.id}
          onCopyCloudLink={onCopyCloudLink}
          onRestoreCloud={onRestoreCloud}
          onResyncCloud={onResyncCloud}
        />
        <CollapsiblePrompt
          expanded={expanded}
          label={t("galleryPromptLabel")}
          lines={2}
          text={item.prompt}
          onToggle={() => onTogglePrompt(item.outputId)}
        />
        <div className="gallery-card__footer">
          <span className="gallery-time-tag">
            <Clock3 className="size-3.5" aria-hidden="true" />
            {formatCreatedTime(item.createdAt, formatDateTime)}
          </span>
          <GalleryIconActions
            copied={copied}
            deleting={deleting}
            item={item}
            onCopy={onCopy}
            onDelete={onDelete}
            onDownload={onDownload}
            onReuse={onReuse}
          />
        </div>
      </div>
    </article>
  );
}

function GalleryIconActions({
  copied,
  deleting,
  item,
  onCopy,
  onDelete,
  onDownload,
  onReuse
}: {
  copied: boolean;
  deleting: boolean;
  item: GalleryImageItem;
  onCopy: (item: GalleryImageItem) => void;
  onDelete: (item: GalleryImageItem) => void;
  onDownload: (item: GalleryImageItem) => void;
  onReuse: (item: GalleryImageItem) => void;
}) {
  const { t } = useI18n();
  const excerpt = promptExcerpt(item.prompt);

  return (
    <div className="gallery-card__actions">
      <button
        aria-label={copied ? t("galleryCopiedPrompt") : t("galleryActionCopyPrompt", { excerpt })}
        className="gallery-icon-action"
        data-copied={copied}
        title={copied ? t("galleryCopiedPrompt") : t("galleryPromptLabel")}
        type="button"
        onClick={() => onCopy(item)}
      >
        <span className="gallery-icon-action__icon-stack" aria-hidden="true">
          <Copy className="gallery-icon-action__icon gallery-icon-action__icon--copy size-4" />
          <CheckCircle2 className="gallery-icon-action__icon gallery-icon-action__icon--check size-4" />
        </span>
      </button>
      <button
        aria-label={t("galleryActionDownloadImage", { excerpt })}
        className="gallery-icon-action"
        title={t("galleryDownloadOriginal")}
        type="button"
        onClick={() => onDownload(item)}
      >
        <Download className="size-4" aria-hidden="true" />
      </button>
      <button
        aria-label={t("galleryActionReusePrompt", { excerpt })}
        className="gallery-icon-action"
        title={t("galleryReuseToCanvas")}
        type="button"
        onClick={() => onReuse(item)}
      >
        <RotateCcw className="size-4" aria-hidden="true" />
      </button>
      <button
        aria-label={t("galleryActionDeleteImage", { excerpt })}
        className="gallery-icon-action gallery-icon-action--danger"
        disabled={deleting}
        title={t("galleryRemovedTitle")}
        type="button"
        onClick={() => onDelete(item)}
      >
        {deleting ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Trash2 className="size-4" aria-hidden="true" />}
      </button>
    </div>
  );
}

function GalleryTags({ item, compact = false }: { item: GalleryImageItem; compact?: boolean }) {
  const { t } = useI18n();
  const styleLabel = styleTagLabel(item.presetId, t);
  const sizeLabel = sizeTagLabel(item, t);

  return (
    <div className="gallery-tags" data-compact={compact}>
      <span className="gallery-tag gallery-tag--mode">{t("galleryModeLabel", { mode: item.mode })}</span>
      {styleLabel ? (
        <span className="gallery-tag gallery-tag--style">
          <Palette className="size-3.5" aria-hidden="true" />
          {styleLabel}
        </span>
      ) : null}
      <span className="gallery-tag gallery-tag--size">
        <Ruler className="size-3.5" aria-hidden="true" />
        {sizeLabel}
      </span>
    </div>
  );
}

function CloudStatusPanel({
  cloud,
  compact = false,
  item,
  pending,
  onCopyCloudLink,
  onRestoreCloud,
  onResyncCloud
}: {
  cloud: AssetCloudStatusResponse | undefined;
  compact?: boolean;
  item: GalleryImageItem;
  pending: boolean;
  onCopyCloudLink: (item: GalleryImageItem) => void;
  onRestoreCloud: (item: GalleryImageItem) => void;
  onResyncCloud: (item: GalleryImageItem) => void;
}) {
  const { formatDateTime, t } = useI18n();
  const status = cloudStatusDisplay(cloud, t);
  const excerpt = promptExcerpt(item.prompt);
  const canCopyLink = cloud?.provider === "my_tools" && cloud.status === "uploaded" && Boolean(cloud.publicUrl);
  const canRefreshLink = cloud?.provider === "my_tools" && cloud.status === "uploaded";
  const canRestore = cloud?.provider === "my_tools" && cloud.readable;

  return (
    <div className="gallery-cloud" data-compact={compact} data-status={status.tone}>
      <div className="gallery-cloud__summary">
        {status.icon}
        <span>{status.label}</span>
        {cloud?.syncedAt ? <time dateTime={cloud.syncedAt}>{formatDateTime(cloud.syncedAt)}</time> : null}
      </div>
      <div className="gallery-cloud__actions">
        <button
          aria-label={t("galleryActionResyncCloud", { excerpt })}
          className="gallery-cloud__button"
          disabled={pending}
          title={t("galleryCloudResync")}
          type="button"
          onClick={() => onResyncCloud(item)}
        >
          {pending ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <CloudUpload className="size-3.5" aria-hidden="true" />}
          <span>{t("galleryCloudResync")}</span>
        </button>
        <button
          aria-label={t("galleryActionRestoreCloud", { excerpt })}
          className="gallery-cloud__button"
          disabled={!canRestore || pending}
          title={t("galleryCloudRestore")}
          type="button"
          onClick={() => onRestoreCloud(item)}
        >
          <CloudDownload className="size-3.5" aria-hidden="true" />
          <span>{t("galleryCloudRestore")}</span>
        </button>
        <button
          aria-label={t("galleryActionCopyCloudLink", { excerpt })}
          className="gallery-cloud__button"
          disabled={(!canCopyLink && !canRefreshLink) || pending}
          title={t("galleryCloudCopyLink")}
          type="button"
          onClick={() => onCopyCloudLink(item)}
        >
          <Link2 className="size-3.5" aria-hidden="true" />
          <span>{t("commonCopy")}</span>
        </button>
      </div>
    </div>
  );
}

function cloudStatusDisplay(cloud: AssetCloudStatusResponse | undefined, t: Translate): { label: string; tone: string; icon: ReactElement } {
  if (!cloud) {
    return {
      label: t("galleryCloudNotSynced"),
      tone: "idle",
      icon: <CloudOff className="size-3.5" aria-hidden="true" />
    };
  }
  if (cloud.status === "failed") {
    return {
      label: t("galleryCloudFailed"),
      tone: "failed",
      icon: <AlertTriangle className="size-3.5" aria-hidden="true" />
    };
  }
  if (cloud.status === "missing") {
    return {
      label: t("galleryCloudMissing"),
      tone: "missing",
      icon: <CloudOff className="size-3.5" aria-hidden="true" />
    };
  }
  if (cloud.status === "deleted") {
    return {
      label: t("galleryCloudDeleted"),
      tone: "missing",
      icon: <CloudOff className="size-3.5" aria-hidden="true" />
    };
  }
  if (!cloud.readable) {
    return {
      label: t("galleryCloudPending"),
      tone: "pending",
      icon: <Cloud className="size-3.5" aria-hidden="true" />
    };
  }

  return {
    label: t("galleryCloudUploaded"),
    tone: "uploaded",
    icon: <Cloud className="size-3.5" aria-hidden="true" />
  };
}

function CollapsiblePrompt({
  expanded,
  label,
  lines,
  text,
  onToggle
}: {
  expanded: boolean;
  label: string;
  lines: 2 | 4 | 8;
  text: string;
  onToggle: () => void;
}) {
  const { t } = useI18n();

  return (
    <section className="gallery-prompt-block">
      <div className="gallery-prompt-heading">
        <h3 className="gallery-prompt-label">{label}</h3>
        <button
          aria-expanded={expanded}
          className="gallery-prompt-toggle"
          data-expanded={expanded}
          type="button"
          onClick={onToggle}
        >
          {expanded ? t("galleryToggleCollapse") : t("galleryToggleExpand")}
          <ChevronDown className="size-3.5" aria-hidden="true" />
        </button>
      </div>
      <p className="gallery-prompt-text" data-expanded={expanded} data-lines={lines}>
        {text}
      </p>
    </section>
  );
}

function GalleryDetailDialog({
  cloud,
  copied,
  deleting,
  item,
  pendingCloud,
  onClose,
  onCopyCloudLink,
  onCopy,
  onDelete,
  onDownload,
  onRestoreCloud,
  onResyncCloud,
  onReuse
}: {
  cloud: AssetCloudStatusResponse | undefined;
  copied: boolean;
  deleting: boolean;
  item: GalleryImageItem;
  pendingCloud: boolean;
  onClose: () => void;
  onCopyCloudLink: () => void;
  onCopy: () => void;
  onDelete: () => void;
  onDownload: () => void;
  onRestoreCloud: () => void;
  onResyncCloud: () => void;
  onReuse: () => void;
}) {
  const [promptExpanded, setPromptExpanded] = useState(false);
  const { formatDateTime, t } = useI18n();

  return (
    <div className="gallery-modal-backdrop app-modal-backdrop" data-testid="gallery-detail" role="presentation">
      <div aria-labelledby="gallery-detail-title" aria-modal="true" className="gallery-modal app-modal-surface" role="dialog">
        <header className="gallery-modal__header">
          <div className="gallery-modal__title">
            <p>{t("galleryDetailEyebrow")}</p>
            <h2 id="gallery-detail-title">{t("galleryDetailTitle")}</h2>
            <GalleryTags item={item} />
          </div>
          <button aria-label={t("commonClose")} className="gallery-icon-action gallery-modal__close" type="button" onClick={onClose}>
            <X className="size-4" aria-hidden="true" />
          </button>
        </header>

        <div className="gallery-modal__body">
          <div className="gallery-modal__media">
            <img
              alt={item.prompt}
              className="gallery-modal__image"
              height={item.asset.height}
              src={item.asset.url}
              width={item.asset.width}
            />
          </div>

          <aside className="gallery-modal__copy">
            <div className="gallery-modal__meta">
              <span>
                <Clock3 className="size-3.5" aria-hidden="true" />
                {formatCreatedTime(item.createdAt, formatDateTime)}
              </span>
              <span>{item.outputFormat.toUpperCase()}</span>
              <span>{t("qualityLabel", { quality: item.quality })}</span>
            </div>
            <CloudStatusPanel
              cloud={cloud}
              item={item}
              pending={pendingCloud}
              onCopyCloudLink={() => onCopyCloudLink()}
              onRestoreCloud={() => onRestoreCloud()}
              onResyncCloud={() => onResyncCloud()}
            />
            <CollapsiblePrompt
              expanded={promptExpanded}
              label={t("galleryPromptLabel")}
              lines={8}
              text={item.prompt}
              onToggle={() => setPromptExpanded((current) => !current)}
            />
          </aside>
        </div>

        <footer className="gallery-modal__actions">
          <button
            aria-label={copied ? t("galleryCopiedPrompt") : t("commonCopy")}
            className="secondary-action gallery-copy-action h-10"
            data-copied={copied}
            title={copied ? t("galleryCopiedPrompt") : t("commonCopy")}
            type="button"
            onClick={onCopy}
          >
            <span className="gallery-icon-action__icon-stack" aria-hidden="true">
              <Copy className="gallery-icon-action__icon gallery-icon-action__icon--copy size-4" />
              <CheckCircle2 className="gallery-icon-action__icon gallery-icon-action__icon--check size-4" />
            </span>
            {t("commonCopy")}
          </button>
          <button className="secondary-action h-10" type="button" onClick={onDownload}>
            <Download className="size-4" aria-hidden="true" />
            {t("commonDownload")}
          </button>
          <button className="secondary-action h-10" type="button" onClick={onReuse}>
            <RotateCcw className="size-4" aria-hidden="true" />
            {t("commonReuse")}
          </button>
          <button className="secondary-action h-10 text-red-700 hover:text-red-800" disabled={deleting} type="button" onClick={onDelete}>
            {deleting ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Trash2 className="size-4" aria-hidden="true" />}
            {t("commonRemove")}
          </button>
        </footer>
      </div>
    </div>
  );
}

function DeleteGalleryDialog({
  deleting,
  item,
  onCancel,
  onConfirm
}: {
  deleting: boolean;
  item: GalleryImageItem;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();

  return (
    <div className="gallery-confirm-backdrop app-modal-backdrop" data-testid="gallery-delete-dialog" role="presentation">
      <div
        aria-describedby="gallery-delete-description"
        aria-labelledby="gallery-delete-title"
        aria-modal="true"
        className="gallery-confirm app-modal-surface"
        role="dialog"
      >
        <div className="gallery-confirm__icon">
          <AlertTriangle className="size-5" aria-hidden="true" />
        </div>
        <div className="gallery-confirm__copy">
          <h2 id="gallery-delete-title">{t("galleryConfirmDeleteTitle")}</h2>
          <p id="gallery-delete-description">
            {t("galleryConfirmDeleteBody", { excerpt: promptExcerpt(item.prompt) })}
          </p>
        </div>
        <div className="gallery-confirm__actions">
          <button className="secondary-action h-10" disabled={deleting} type="button" onClick={onCancel}>
            {t("commonCancel")}
          </button>
          <button className="danger-action h-10" disabled={deleting} type="button" onClick={onConfirm}>
            {deleting ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Trash2 className="size-4" aria-hidden="true" />}
            {t("galleryConfirmRemove")}
          </button>
        </div>
      </div>
    </div>
  );
}

function styleTagLabel(presetId: string, t: Translate): string {
  if (presetId === "none") {
    return "";
  }

  const preset = STYLE_PRESETS.find((item) => item.id === presetId);
  return preset ? t("stylePresetLabel", { presetId: preset.id, fallback: preset.label }) : "";
}

function sizeTagLabel(item: GalleryImageItem, t: Translate): string {
  const preset = SIZE_PRESETS.find((sizePreset) => sizePreset.width === item.size.width && sizePreset.height === item.size.height);
  const presetLabel = preset ? t("sizePresetLabel", { presetId: preset.id, fallback: preset.label }) : t("customSize");
  return `${presetLabel} · ${item.size.width} x ${item.size.height}`;
}

function initialCloudStatusByAssetId(items: GalleryImageItem[]): Record<string, AssetCloudStatusResponse> {
  return Object.fromEntries(
    items.flatMap((item) => {
      const cloud = item.asset.cloud;
      if (!cloud) {
        return [];
      }

      return [
        [
          item.asset.id,
          {
            assetId: item.asset.id,
            provider: cloud.provider,
            status: cloud.status,
            readable: cloud.readable ?? cloud.status === "uploaded",
            visibility: cloud.visibility ?? "private",
            publicUrl: cloud.publicUrl,
            syncedAt: cloud.syncedAt ?? cloud.uploadedAt,
            mimeType: item.asset.mimeType,
            lastError: cloud.lastError
          } satisfies AssetCloudStatusResponse
        ]
      ];
    })
  );
}

function toGeneratedAssetCloud(cloud: AssetCloudStatusResponse): GeneratedAssetCloudInfo | undefined {
  if (!cloud.provider) {
    return undefined;
  }

  return {
    provider: cloud.provider,
    status: cloud.status,
    lastError: cloud.lastError,
    publicUrl: cloud.visibility === "public" ? cloud.publicUrl : undefined,
    readable: cloud.readable,
    syncedAt: cloud.syncedAt,
    uploadedAt: cloud.syncedAt,
    visibility: cloud.visibility
  };
}

function promptExcerpt(promptValue: string): string {
  const compact = promptValue.replace(/\s+/gu, " ").trim();
  return compact.length > 48 ? `${compact.slice(0, 48)}...` : compact;
}

function formatCreatedTime(value: string, formatDateTime: (value: string) => string): string {
  return formatDateTime(value);
}

function normalizeSearchText(value: string): string {
  return value.replace(/\s+/gu, " ").trim().toLocaleLowerCase();
}

async function readGalleryError(response: Response, locale: Locale, t: Translate): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    return localizedApiErrorMessage({
      code: body.error?.code,
      fallbackMessage: body.error?.message,
      fallbackText: t("galleryRequestFailed", { status: response.status }),
      locale,
      status: response.status
    });
  } catch {
    return t("galleryRequestFailed", { status: response.status });
  }
}

async function writeClipboardText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.readOnly = true;
  textArea.style.position = "fixed";
  textArea.style.left = "-9999px";
  textArea.style.top = "0";
  document.body.append(textArea);
  textArea.select();

  try {
    const copied = document.execCommand("copy");
    if (!copied) {
      throw new Error("Copy command was not accepted.");
    }
  } finally {
    textArea.remove();
  }
}
