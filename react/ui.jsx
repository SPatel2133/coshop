import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { faces } from "../client/rooms.js";

export const money = ({ currency, cents }, display = "symbol") =>
  cents == null
    ? "Price unavailable"
    : new Intl.NumberFormat("en-CA", {
        style: "currency",
        currency,
        currencyDisplay: display,
      }).format(cents / 100);
export const exact = (item) => item.name + " · " + item.variant;
export const countItems = (n) => n + (n === 1 ? " item" : " items");
export const focus = (node) => node?.focus({ preventScroll: true });
export const visible = (node) =>
  node?.isConnected && node.getClientRects().length;
export const wideQuery = "(min-width: 768px)";

export function useMedia(query) {
  const [matches, set] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const media = matchMedia(query);
    const update = () => set(media.matches);
    media.addEventListener("change", update);
    update();
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

export function Face({ avatar }) {
  return (
    <span className={"face " + (avatar || "sage")} aria-hidden="true">
      {faces[avatar] || ":)"}
    </span>
  );
}

export function Photo({
  src,
  alt = "",
  className = "product-media",
  lazy = false,
}) {
  const [failedSource, setFailedSource] = useState(null);
  return (
    <span className={className}>
      {src && failedSource !== src ? (
        <img
          src={src}
          alt={alt}
          loading={lazy ? "lazy" : undefined}
          onError={() => setFailedSource(src)}
        />
      ) : (
        <span className="fine">Image unavailable</span>
      )}
    </span>
  );
}

let pageLock;

export function Modal({
  id,
  label,
  side,
  active,
  close,
  modal = true,
  className = "",
  children,
}) {
  const ref = useRef(null);
  const ownsLock = useRef(false);
  const reduced = useMedia("(prefers-reduced-motion: reduce)");
  const presentation = useRef(null);
  const exitIntent = useRef(null);
  const isActive = useRef(active);
  const onClose = useRef(close);
  onClose.current = close;
  isActive.current = active;
  const lock = () => {
    if (ownsLock.current) return;
    ownsLock.current = true;
    if (pageLock) {
      pageLock.layers++;
      return;
    }
    pageLock = { x: scrollX, y: scrollY, layers: 1 };
    document.documentElement.classList.add("coshop-modal-open");
    document.body.style.setProperty("--modal-scroll", -pageLock.y + "px");
  };
  const unlock = () => {
    if (!ownsLock.current) return;
    ownsLock.current = false;
    if (--pageLock.layers) return;
    document.documentElement.classList.remove("coshop-modal-open");
    document.body.style.removeProperty("--modal-scroll");
    scrollTo(pageLock.x, pageLock.y);
    pageLock = null;
  };
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!active) {
      exitIntent.current = null;
      if (dialog.open) dialog.close();
      unlock();
      presentation.current = null;
      return;
    }
    if (dialog.open && presentation.current === modal) return;
    const previous = dialog.contains(document.activeElement)
      ? document.activeElement
      : null;
    if (dialog.open) dialog.close();
    unlock();
    exitIntent.current = null;
    delete dialog.dataset.exiting;
    presentation.current = modal;
    if (modal) {
      lock();
      dialog.showModal();
    } else dialog.show();
    focus(previous || dialog.querySelector("[data-dialog-close]"));
  }, [active, modal]);
  useLayoutEffect(
    () => () => {
      exitIntent.current = null;
      if (ref.current?.open) ref.current.close();
      unlock();
    },
    [],
  );

  async function dismiss(action, immediate = false) {
    const dialog = ref.current;
    if (!dialog?.open || !isActive.current) return;
    const finish = () => {
      if (!dialog.open || !isActive.current) return;
      dialog.close();
      unlock();
      onClose.current(action);
    };
    if (immediate || reduced || typeof dialog.getAnimations !== "function")
      return finish();
    if (exitIntent.current) return;
    const intent = (exitIntent.current = {});
    dialog.dataset.exiting = "true";
    const transitions = dialog
      .getAnimations({ subtree: true })
      .filter((item) => item.effect?.target === dialog);
    if (transitions.length)
      await Promise.allSettled(transitions.map((item) => item.finished));
    if (exitIntent.current !== intent) return;
    exitIntent.current = null;
    delete dialog.dataset.exiting;
    finish();
  }
  useEffect(() => {
    if (!active || modal) return;
    function onEscape(event) {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        event.isComposing ||
        document.querySelector("dialog:modal")
      )
        return;
      event.preventDefault();
      dismiss();
    }
    document.addEventListener("keydown", onEscape);
    return () => document.removeEventListener("keydown", onEscape);
  }, [active, modal, reduced]);

  return (
    <dialog
      ref={ref}
      id={id}
      aria-labelledby={label}
      data-motion={side || "center"}
      className={"react-modal " + className}
      onCancel={(event) => {
        event.preventDefault();
        dismiss();
      }}
    >
      {children(dismiss)}
    </dialog>
  );
}

export function DialogClose({ onClick, children, label }) {
  return (
    <button
      type="button"
      className="quiet dialog-close"
      data-dialog-close
      onClick={onClick}
      aria-label={label}
    >
      {children}
      <span aria-hidden="true" className="close-glyph">
        ×
      </span>
    </button>
  );
}
