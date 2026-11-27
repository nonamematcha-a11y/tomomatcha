"use client";

/* ============================================================================
 * Muesca del aviso de ambiente, con opción de subirla.
 *
 * Es un componente de cliente sólo porque recuerda si está arriba o abajo.
 * Ese recuerdo vive en `sessionStorage`: dura mientras la pestaña esté
 * abierta y cada pestaña nueva arranca con el aviso visible, que es lo
 * seguro. Si el navegador no deja guardar, simplemente no se recuerda.
 * ========================================================================== */

import { useEffect, useState } from "react";

const STORAGE_KEY = "tm-env-notch-up";

export function EnvNotch({ label }: { label: string }) {
  const [up, setUp] = useState(false);

  useEffect(() => {
    try {
      setUp(window.sessionStorage.getItem(STORAGE_KEY) === "1");
    } catch {
      /* sin almacenamiento: el aviso se queda abajo */
    }
  }, []);

  const toggle = () => {
    const next = !up;
    setUp(next);
    try {
      window.sessionStorage.setItem(STORAGE_KEY, next ? "1" : "0");
    } catch {
      /* sin almacenamiento: sólo dura en esta vista */
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={up ? `Mostrar aviso: ${label}` : `Subir aviso: ${label}`}
      title={up ? "Mostrar aviso" : "Subir aviso"}
      className={[
        "fixed left-1/2 top-0 z-[61] flex -translate-x-1/2 flex-col items-center",
        "rounded-b-2xl bg-[#f59e0b] px-5 text-[#1c1917] shadow-lg",
        "transition-transform duration-300 ease-out motion-reduce:transition-none",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1c1917]",
        up ? "-translate-y-[calc(100%_-_10px)]" : "translate-y-0",
      ].join(" ")}
    >
      <span className="pt-1 text-[12px] font-extrabold uppercase tracking-[0.2em]">
        {label}
      </span>
      <span aria-hidden className="pb-0.5 text-[10px] leading-none">
        {up ? "▼" : "▲"}
      </span>
    </button>
  );
}
