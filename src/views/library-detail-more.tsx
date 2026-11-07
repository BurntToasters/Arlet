import { ChevronDown } from "lucide-preact";
import { useState } from "preact/hooks";
import type { JSX } from "preact";
import { useAppRouter } from "../app/context.tsx";
import type { Album } from "../domain/music.ts";
import { serializeRoute } from "../routing/router.ts";
import type { ResourceLike } from "./LibraryView.tsx";
import { detailNotes } from "./detail-meta.ts";

/** Collapsed notes, label and copyright; renders nothing when there are none. */
export function DetailMore({
  kind,
  resource,
}: {
  kind: "album" | "playlist";
  resource: ResourceLike;
}): JSX.Element | null {
  const router = useAppRouter();
  const [open, setOpen] = useState(false);
  const details = detailNotes(kind, resource);
  // An album with a record label gets a link even when its notes are empty.
  const info = resource.raw as Partial<Album>;
  const labelId = kind === "album" ? info.recordLabelId : undefined;
  const labelName = info.recordLabelName ?? info.recordLabel;
  if (!details && !labelId) return null;
  return (
    <section className="library-detail-more">
      <button
        className="library-detail-more-toggle"
        type="button"
        aria-expanded={open}
        aria-controls="library-detail-more-panel"
        onClick={() => setOpen((value) => !value)}
      >
        More <ChevronDown aria-hidden="true" size={14} />
      </button>
      <div
        id="library-detail-more-panel"
        className="library-detail-more-body"
        hidden={!open}
      >
        {details?.notes ? (
          <p className="library-detail-notes">{details.notes}</p>
        ) : null}
        {labelId || details?.recordLabel || details?.copyright ? (
          <dl className="library-detail-facts">
            {labelId || details?.recordLabel ? (
              <>
                <dt>Label</dt>
                <dd>
                  {labelId ? (
                    // The href is the label route; the click navigates in-app.
                    <a
                      className="curator-link"
                      href={serializeRoute({ kind: "label", id: labelId })}
                      aria-label={
                        labelName
                          ? `Record label: ${labelName}`
                          : "Record label"
                      }
                      onClick={(event) => {
                        event.preventDefault();
                        router.navigate({ kind: "label", id: labelId });
                      }}
                    >
                      {labelName ?? "Record label"}
                    </a>
                  ) : (
                    details?.recordLabel
                  )}
                </dd>
              </>
            ) : null}
            {details?.copyright ? (
              <>
                <dt>Copyright</dt>
                <dd>{details.copyright}</dd>
              </>
            ) : null}
          </dl>
        ) : null}
      </div>
    </section>
  );
}
