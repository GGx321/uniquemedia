import { useState } from "react";
import { useEngine } from "../engine/react";
import { photoUrl, placeholderGradient } from "../lib/media";

function Silhouette() {
  return (
    <svg className="portrait-silhouette" viewBox="0 0 100 130" preserveAspectRatio="xMidYMax meet" aria-hidden="true" focusable="false">
      <g fill="#140c0a" opacity="0.34">
        <ellipse cx="50" cy="50" rx="19" ry="23" />
        <rect x="44" y="66" width="12" height="22" rx="4" />
        <path d="M12 130 C14 100 30 84 50 84 C70 84 86 100 88 130 Z" />
      </g>
    </svg>
  );
}

/** A neutral stand-in: the mock engine has no images, and a real one may fail to load. */
export function PortraitPlaceholder({ seed, label }: { seed: string; label: string }) {
  return (
    <div className="portrait portrait-placeholder" role="img" aria-label={label} style={{ background: placeholderGradient(seed) }}>
      <Silhouette />
    </div>
  );
}

/** A library photo through `studio-media://`, or a placeholder in mock mode or when it cannot load. */
export function Portrait({ avatarId, photoId, label }: { avatarId: string; photoId: string; label: string }) {
  const { client } = useEngine();
  const [failed, setFailed] = useState(false);
  const src = photoUrl(avatarId, photoId);
  if (client.kind === "mock" || failed || src === null) return <PortraitPlaceholder seed={photoId} label={label} />;
  return (
    <div className="portrait">
      <img className="portrait-img" src={src} alt={label} loading="lazy" decoding="async" onError={() => setFailed(true)} />
    </div>
  );
}
