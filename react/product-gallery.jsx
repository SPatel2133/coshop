import React, { useState } from "react";
import gallery from "./sample-gallery.json";
import { Photo } from "./ui.jsx";

export function ProductGallery({ product, variant }) {
  const primary = variant.image || product.image;
  const extras = gallery[variant.id] || gallery[product.id] || [];
  const images = [
    ...(primary ? [{ src: primary, label: `Show primary photo of ${product.name} — ${variant.title}` }] : []),
    ...extras.map(({ src, view }) => ({
      src,
      label: `Show ${view} of ${product.name} — ${variant.title}`,
    })),
  ];
  return <GalleryMedia key={variant.id} images={images} name={product.name} primary={primary} />;
}

function GalleryMedia({ images, name, primary }) {
  const [selected, select] = useState(primary);
  const [failed, setFailed] = useState(() => new Set());
  const usable = images.filter(({ src }) => !failed.has(src));
  const current = usable.find(({ src }) => src === selected) || usable[0];

  if (images.length < 2)
    return <Photo className="product-media detail-media" src={primary} alt={name} />;

  return (
    <div className="product-gallery">
      <Photo className="product-media detail-media" src={current?.src} alt={name} />
      {usable.length > 1 && (
        <div className="thumbnail-rail" role="group" aria-label="Product photos">
          {usable.map(({ src, label }) => (
            <button
              type="button"
              key={src}
              aria-label={label}
              aria-pressed={current?.src === src}
              onClick={() => select(src)}
            >
              <img src={src} alt="" onError={() => setFailed((old) => new Set([...old, src]))} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
