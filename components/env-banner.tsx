/* ============================================================================
 * Aviso de ambiente de pruebas.
 *
 * Marco ámbar alrededor de toda la pantalla y una muesca («notch») arriba al
 * centro, en cualquier despliegue que no sea producción. El marco no recibe
 * clics (`pointer-events-none`) para no tapar ni mover ningún botón.
 *
 * La muesca sí se puede subir con un clic cuando estorba (por ejemplo, si
 * tapa algo del encabezado en el celular): se esconde hacia arriba y deja una
 * pestañita para bajarla otra vez. El marco se queda siempre, para que el
 * aviso nunca desaparezca del todo.
 *
 * En producción `environmentLabel()` es `null` y no se pinta nada, así que
 * puede vivir en el layout raíz sin condiciones extra.
 * ========================================================================== */

import { environmentLabel } from "@/lib/env";
import { EnvNotch } from "@/components/env-notch";

export function EnvBanner() {
  const label = environmentLabel();
  if (!label) return null;

  return (
    <>
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 z-[60] border-[5px] border-[#f59e0b]"
      />
      <EnvNotch label={label} />
    </>
  );
}
