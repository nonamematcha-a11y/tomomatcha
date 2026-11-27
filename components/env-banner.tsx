/* ============================================================================
 * Aviso de ambiente de pruebas.
 *
 * Marco ámbar alrededor de toda la pantalla y una etiqueta fija arriba, en
 * cualquier despliegue que no sea producción. Va encima de todo y no recibe
 * clics (`pointer-events-none`) para no tapar ni mover ningún botón: el
 * diseño de la aplicación queda idéntico, sólo se le pone un marco.
 *
 * En producción `environmentLabel()` es `null` y este componente no pinta
 * nada, así que puede vivir en el layout raíz sin condiciones extra.
 * ========================================================================== */

import { environmentLabel } from "@/lib/env";

export function EnvBanner() {
  const label = environmentLabel();
  if (!label) return null;

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-[60] border-[5px] border-[#f59e0b]"
    >
      <div className="absolute left-1/2 top-0 -translate-x-1/2 rounded-b-xl bg-[#f59e0b] px-4 py-1 text-[11px] font-extrabold uppercase tracking-[0.18em] text-[#1c1917] shadow-lg">
        {label} · no es la tienda real
      </div>
    </div>
  );
}
