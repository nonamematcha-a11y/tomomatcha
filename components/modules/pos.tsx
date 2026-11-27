"use client";

import Link from "next/link";
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { checkout } from "@/lib/actions";
import { ShiftCloseModal, ShiftStartOverlay } from "@/components/modules/shift";
import { useDerived, useStore } from "@/lib/store";
import { money } from "@/lib/format";
import { SHOW_LEALTAD_UI } from "@/lib/feature-visibility";
import {
  PAYMENT_META,
  pointsFor,
  SERVICE_META,
  SWEETNESS_STEPS,
  type CartLine,
  type CategoryId,
  type LineModifiers,
  type PaymentMethod,
  type Product,
  type ServiceMode,
  type Sweetness,
  type Temperature,
} from "@/lib/types";
import {
  ConfirmButton,
  Button,
  Card,
  EmptyState,
  Input,
  MediaImage,
  Modal,
  PageHeader,
  cx,
  numericText,
} from "@/components/ui";

const PROMOS: { pct: number; label: string }[] = [
  { pct: 0, label: "Sin promoción" },
  { pct: 10, label: "Descuento 10%" },
  { pct: 15, label: "Cliente frecuente 15%" },
];

// Tres porcentajes sugeridos de propina, los que cubren casi todos los casos
// en barra: teclear con gente esperando es lo que hay que evitar. El «Sin
// propina» que los precede es el estado por omisión, y es explícito a
// propósito: dejar propina tiene que ser una elección, no algo que se cuela.
const TIP_PCTS = [10, 15, 20];

const TEMP_LABEL: Record<Temperature, string> = {
  caliente: "Caliente",
  frio: "Frío",
};

const TEMP_EMOJI: Record<Temperature, string> = {
  caliente: "🔥",
  frio: "🧊",
};

/**
 * Porcentaje de propina tal como se enseña en el ticket: sin decimales cuando
 * es redondo (el caso normal) y con ellos sólo si el cajero los tecleó.
 */
function pctLabel(pct: number): string {
  return String(Math.round(pct * 100) / 100);
}

function sweetnessLabel(s: Sweetness): string {
  return s === 0 ? "Sin azúcar" : `${s}%`;
}

/** Borrador de renglón mientras se personaliza en el modal. */
interface DraftLine {
  /** key del renglón que se edita; null cuando es un renglón nuevo */
  lineKey: string | null;
  productId: string;
  qty: number;
  milkId?: string;
  sweetness?: Sweetness;
  temperature?: Temperature;
  extraIds: string[];
  notes: string;
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cx(
        "focus-ring max-w-full break-words rounded-full border px-3.5 py-1.5 text-xs font-bold transition",
        active
          ? "border-matcha bg-matcha-mist text-matcha-deep"
          : "border-line bg-white text-ink hover:border-matcha",
      )}
    >
      {active ? "✓ " : ""}
      {children}
    </button>
  );
}

export function PosModule() {
  const { state, currency, submit, busy, notify } = useStore();
  const { cashClosedToday } = useDerived();

  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<CategoryId | "todos">("todos");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [draft, setDraft] = useState<DraftLine | null>(null);
  const [promoPct, setPromoPct] = useState(0);
  // Descuento variable (como en Loyverse): si se teclea un porcentaje, manda
  // sobre la promoción elegida. Vacío = se usa la promoción.
  const [discountCustomPct, setDiscountCustomPct] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [payment, setPayment] = useState<PaymentMethod>("efectivo");
  // Por omisión "para llevar": si el cajero olvida cambiarlo, el sistema
  // descuenta empaque de más y no de menos, que es el error menos costoso.
  const [serviceMode, setServiceMode] = useState<ServiceMode>("llevar");
  const [cashReceived, setCashReceived] = useState("");
  // Propina: siempre un porcentaje sobre el consumo, sea uno de los sugeridos
  // o uno escrito a mano. Nunca las dos cosas a la vez, para que la caja no
  // tenga que adivinar cuál gana. Arranca en 0 en cada venta.
  const [tipPct, setTipPct] = useState(0);
  const [tipCustomPct, setTipCustomPct] = useState("");
  const [mobileTicketOpen, setMobileTicketOpen] = useState(false);
  // Fase del cobro: 1) armar la orden, 2) ticket final y pago.
  const [phase, setPhase] = useState<"orden" | "cobro">("orden");
  // Modal de «Terminar turno» / «Resultados del día».
  const [shiftCloseOpen, setShiftCloseOpen] = useState(false);

  /*
   * Ticket y panel de pago a la misma altura (solo lado a lado, desde tablet).
   * Se mide la altura natural de cada lado y ambos toman la mayor; el cambio
   * se anima con `transition-[height]` para que crezca suave y no de golpe.
   * En el ticket la diferencia la absorbe un espaciador entre los renglones y
   * los totales, así los totales siempre quedan abajo, junto al zigzag.
   */
  const receiptTopRef = useRef<HTMLDivElement>(null);
  const receiptBottomRef = useRef<HTMLDivElement>(null);
  const payInnerRef = useRef<HTMLDivElement>(null);
  const [rowH, setRowH] = useState<number | null>(null);
  const [receiptNatural, setReceiptNatural] = useState(0);

  useLayoutEffect(() => {
    if (phase !== "cobro") return;
    const top = receiptTopRef.current;
    const bottom = receiptBottomRef.current;
    const pay = payInnerRef.current;
    if (!top || !bottom || !pay) return;
    const wide = window.matchMedia("(min-width: 768px)");

    const measure = () => {
      if (!wide.matches) {
        setRowH(null);
        return;
      }
      const receipt = top.offsetHeight + bottom.offsetHeight;
      setReceiptNatural(receipt);
      setRowH(Math.max(receipt, pay.offsetHeight));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(top);
    ro.observe(bottom);
    ro.observe(pay);
    wide.addEventListener("change", measure);
    return () => {
      ro.disconnect();
      wide.removeEventListener("change", measure);
    };
  }, [phase]);
  const [success, setSuccess] = useState<{ folio: number; total: number } | null>(
    null,
  );
  const lineCounter = useRef(0);

  /* ------------------------------ Catálogo -------------------------------- */

  /*
   * Sólo se ofrecen como filtro las categorías encendidas que además tienen
   * algo que vender hoy: un chip que no lleva a ningún producto sobra en una
   * barra con gente esperando. Si la categoría elegida desaparece (otro
   * administrador la apagó desde Ajustes mientras el turno corría), la vista
   * vuelve sola a «Todos» en lugar de quedarse vacía.
   */
  const visibleCategories = useMemo(
    () =>
      state.categories.filter(
        (c) => c.active && state.products.some((p) => p.active && p.category === c.id),
      ),
    [state.categories, state.products],
  );
  const activeCategory = visibleCategories.some((c) => c.id === category)
    ? category
    : "todos";

  const term = search.trim().toLowerCase();
  const visibleProducts = state.products.filter(
    (p) =>
      p.active &&
      (activeCategory === "todos" || p.category === activeCategory) &&
      (!term ||
        p.name.toLowerCase().includes(term) ||
        p.desc.toLowerCase().includes(term)),
  );

  const availableMilks = useMemo(
    () => state.milks.filter((m) => m.available),
    [state.milks],
  );
  const availableExtras = useMemo(
    () => state.extras.filter((e) => e.available),
    [state.extras],
  );

  /* ---------------------------- Precios de línea --------------------------- */

  const lineUnitPrice = (line: CartLine): number => {
    const product = state.products.find((p) => p.id === line.productId);
    if (!product) return 0;
    const milkSurcharge =
      state.milks.find((m) => m.id === line.modifiers.milkId)?.surcharge ?? 0;
    const extrasSum = line.modifiers.extraIds.reduce(
      (sum, id) => sum + (state.extras.find((e) => e.id === id)?.price ?? 0),
      0,
    );
    return product.price + milkSurcharge + extrasSum;
  };

  /*
   * Desglose del precio de un renglón: producto, leche y extras con lo que
   * suma cada uno, para que quien cobra vea de dónde sale el importe. Lo que
   * no cambia el precio (dulzor, temperatura) va aparte, en `detailsFor`.
   */
  const breakdownFor = (line: CartLine): { label: string; amount: string }[] => {
    const product = state.products.find((p) => p.id === line.productId);
    if (!product) return [];
    const rows = [{ label: product.name, amount: money(product.price, currency) }];
    const milk = line.modifiers.milkId
      ? state.milks.find((mi) => mi.id === line.modifiers.milkId)
      : undefined;
    if (milk) {
      rows.push({
        label: `Leche ${milk.name}`,
        amount: milk.surcharge > 0 ? `+${money(milk.surcharge, currency)}` : "sin costo",
      });
    }
    for (const id of line.modifiers.extraIds) {
      const extra = state.extras.find((e) => e.id === id);
      if (extra) rows.push({ label: extra.name, amount: `+${money(extra.price, currency)}` });
    }
    return rows;
  };

  const detailsFor = (line: CartLine): string => {
    const parts: string[] = [];
    const m = line.modifiers;
    if (m.sweetness !== undefined) {
      parts.push(m.sweetness === 0 ? "Sin azúcar" : `${m.sweetness}% dulzor`);
    }
    if (m.temperature) parts.push(TEMP_LABEL[m.temperature]);
    return parts.join(" · ");
  };

  const subtotal = cart.reduce((sum, l) => sum + lineUnitPrice(l) * l.qty, 0);
  // Lo que se cobra por el consumo, ya con descuento. La propina se calcula
  // sobre esto y se suma después: una promoción no le recorta al equipo lo que
  // el cliente quiso dejarle.
  const discountTyped = discountCustomPct.trim() !== "";
  const typedDiscount = Number(discountCustomPct) || 0;
  const discountOverflow = discountTyped && typedDiscount > 100;
  const discountPct = discountTyped
    ? Math.min(Math.max(typedDiscount, 0), 100)
    : promoPct;
  const consumo = Math.round(subtotal * (1 - discountPct / 100) * 100) / 100;
  const discountAmount = Math.round((subtotal - consumo) * 100) / 100;

  const tipTyped = tipCustomPct.trim() !== "";
  const typedPct = Number(tipCustomPct);
  const rawTipPct = tipTyped
    ? (Number.isFinite(typedPct) ? typedPct : 0)
    : tipPct;
  // Tope en el 100%: una propina mayor que la cuenta es siempre un dedazo, y
  // el mismo tope lo vuelve a aplicar create_order sobre el consumo.
  const tipPctApplied = Math.max(0, Math.min(rawTipPct, 100));
  const tip = Math.round(consumo * tipPctApplied) / 100;
  const tipOverflow = tipTyped && typedPct > 100;

  const total = Math.round((consumo + tip) * 100) / 100;
  const itemCount = cart.reduce((n, l) => n + l.qty, 0);
  const discountLabel = discountTyped
    ? `Descuento ${pctLabel(discountPct)}%`
    : PROMOS.find((p) => p.pct === promoPct)?.label;
  const selectedCustomer = state.customers.find((c) => c.id === customerId);

  // Mercado Pago ya no se ofrece en el cobro; si quedara elegido, vale efectivo.
  const activePayment: PaymentMethod =
    payment === "mercadopago" ? "efectivo" : payment;
  const received = Number(cashReceived) || 0;
  const cashOk = activePayment !== "efectivo" || received >= total;

  // Solo efectivo y tarjeta: Mercado Pago se quitó del cobro a pedido de la
  // dueña. Las ventas viejas con ese método siguen intactas en reportes.
  const paymentOptions: { id: PaymentMethod; emoji: string }[] = [
    { id: "efectivo", emoji: "💵" },
    { id: "tarjeta", emoji: "💳" },
  ];

  /* ------------------------- Borrador (modal de línea) ---------------------- */

  const openProduct = (product: Product) => {
    setDraft({
      lineKey: null,
      productId: product.id,
      qty: 1,
      milkId: product.mods.milk ? availableMilks[0]?.id : undefined,
      sweetness: product.mods.sweetness ? 50 : undefined,
      temperature: product.mods.temperature ? "caliente" : undefined,
      extraIds: [],
      notes: "",
    });
  };

  const openLine = (line: CartLine) => {
    setDraft({
      lineKey: line.key,
      productId: line.productId,
      qty: line.qty,
      milkId: line.modifiers.milkId,
      sweetness: line.modifiers.sweetness,
      temperature: line.modifiers.temperature,
      extraIds: [...line.modifiers.extraIds],
      notes: line.modifiers.notes ?? "",
    });
  };

  const confirmDraft = () => {
    if (!draft) return;
    const notes = draft.notes.trim();
    const modifiers: LineModifiers = {
      milkId: draft.milkId,
      sweetness: draft.sweetness,
      temperature: draft.temperature,
      extraIds: [...draft.extraIds],
      notes: notes ? notes : undefined,
    };
    if (draft.lineKey) {
      setCart((c) =>
        c.map((l) =>
          l.key === draft.lineKey ? { ...l, qty: draft.qty, modifiers } : l,
        ),
      );
    } else {
      const key = `linea-${++lineCounter.current}`;
      setCart((c) => [
        ...c,
        { key, productId: draft.productId, qty: draft.qty, modifiers },
      ]);
    }
    setDraft(null);
  };

  const removeLine = (key: string) => {
    setCart((c) => c.filter((l) => l.key !== key));
  };

  const draftProduct = draft
    ? state.products.find((p) => p.id === draft.productId)
    : undefined;
  let draftUnit = 0;
  if (draft && draftProduct) {
    const milkSurcharge =
      state.milks.find((m) => m.id === draft.milkId)?.surcharge ?? 0;
    const extrasSum = draft.extraIds.reduce(
      (sum, id) => sum + (state.extras.find((e) => e.id === id)?.price ?? 0),
      0,
    );
    draftUnit = draftProduct.price + milkSurcharge + extrasSum;
  }

  /* --------------------------------- Cobro --------------------------------- */

  const canCharge =
    cart.length > 0 && !cashClosedToday && cashOk && !tipOverflow && !busy;

  const handleCheckout = async () => {
    if (!canCharge) return;
    const chargedTotal = total;

    const result = await submit(
      () =>
        checkout({
          lines: cart,
          discountPct,
          discountLabel: discountPct > 0 ? discountLabel : undefined,
          payment: activePayment,
          serviceMode,
          tip,
          customerId:
            SHOW_LEALTAD_UI && state.flags.lealtad && customerId
              ? customerId
              : undefined,
          cashReceived:
            activePayment === "efectivo" && cashReceived !== ""
              ? received
              : undefined,
        }),
      {
        title: (data) => `Venta #${data.folio} registrada`,
        detail: `${money(chargedTotal, currency)} · ${PAYMENT_META[activePayment].short}`,
      },
    );

    if (!result) return;

    setCart([]);
    setPromoPct(0);
    setDiscountCustomPct("");
    setCustomerId("");
    setPayment("efectivo");
    setServiceMode("llevar");
    setCashReceived("");
    setTipPct(0);
    setTipCustomPct("");
    setMobileTicketOpen(false);
    setPhase("orden");
    setSuccess({ folio: result.folio, total: chargedTotal });
  };

  /* ----------------------------- Cuerpo del ticket -------------------------- */

  const packagingCount = state.ingredients.filter(
    (i) => i.isPackaging && i.active,
  ).length;

  /*
   * El cobro va en dos fases, como en Loyverse: primero se arma la ORDEN
   * (productos, cantidades y precio de cada uno) y luego se pasa al TICKET
   * FINAL, donde se eligen servicio, descuento, propina y método de pago. Así
   * quien toma el pedido no se distrae con el cobro, y el cobro no se mezcla
   * con el catálogo.
   *
   * En la orden cada renglón es una tarjeta editable; en el ticket final los
   * mismos renglones se pintan como recibo (solo lectura, líneas punteadas).
   */
  const lineDetail = (line: CartLine) => {
    const breakdown = breakdownFor(line);
    const details = detailsFor(line);
    const unit = lineUnitPrice(line);
    return (
      <>
        {breakdown.length > 1 || line.qty > 1 ? (
          <span className="mt-1.5 block space-y-0.5 text-[11px] text-muted">
            {breakdown.map((row, i) => (
              <span key={i} className="flex items-baseline gap-2">
                <span className="min-w-0 break-words">{row.label}</span>
                <span
                  aria-hidden
                  className="h-px flex-1 translate-y-[-3px] border-b border-dotted border-line"
                />
                <span className="shrink-0 tabular-nums">{row.amount}</span>
              </span>
            ))}
            {line.qty > 1 ? (
              <span className="block font-extrabold text-ink/70">
                {money(unit, currency)} × {line.qty}
              </span>
            ) : null}
          </span>
        ) : null}
        {details ? (
          <span className="mt-1.5 flex flex-wrap gap-1">
            {details.split(" · ").map((d) => (
              <span
                key={d}
                className="rounded-full bg-cream px-2 py-0.5 text-[10px] font-bold text-muted"
              >
                {d}
              </span>
            ))}
          </span>
        ) : null}
        {line.modifiers.notes ? (
          <span className="mt-1 block break-words text-[11px] italic text-muted">
            📝 {line.modifiers.notes}
          </span>
        ) : null}
      </>
    );
  };

  const cartList = (editable: boolean) =>
    cart.length ? (
      <ul className={editable ? "space-y-2" : ""}>
        {cart.map((line) => {
          const product = state.products.find((p) => p.id === line.productId);
          if (!product) return null;
          const lineTotal = money(lineUnitPrice(line) * line.qty, currency);

          if (!editable) {
            return (
              <li
                key={line.key}
                className="border-b border-dashed border-line py-3 last:border-0"
              >
                <span className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 break-words text-sm font-extrabold text-ink">
                    <span className="mr-1.5 tabular-nums text-matcha-deep">
                      {line.qty}×
                    </span>
                    {product.name}
                  </span>
                  <span className="display shrink-0 text-base tabular-nums text-ink">
                    {lineTotal}
                  </span>
                </span>
                {lineDetail(line)}
              </li>
            );
          }

          return (
            <li
              key={line.key}
              className="group relative flex gap-3 rounded-2xl border border-line bg-white p-3 transition hover:border-matcha/60 hover:shadow-card"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink text-xs font-extrabold text-paper">
                {line.qty}
              </span>
              <button
                type="button"
                onClick={() => openLine(line)}
                aria-label={`Editar ${product.name}`}
                className="focus-ring min-w-0 flex-1 rounded-lg text-left"
              >
                <span className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 break-words text-sm font-extrabold text-ink">
                    {product.name}
                  </span>
                  <span className="display shrink-0 text-base tabular-nums text-ink">
                    {lineTotal}
                  </span>
                </span>
                {lineDetail(line)}
              </button>
              <button
                type="button"
                onClick={() => removeLine(line.key)}
                aria-label={`Quitar ${product.name}`}
                className="focus-ring absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full border border-line bg-white text-[11px] font-bold text-muted shadow-card transition hover:border-danger hover:text-danger"
              >
                ✕
              </button>
            </li>
          );
        })}
      </ul>
    ) : (
      <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-line px-4 py-10 text-center">
        <span aria-hidden className="text-4xl">
          🍵
        </span>
        <p className="text-sm font-extrabold text-ink">La orden está vacía</p>
        <p className="text-xs leading-5 text-muted">
          Toca un producto del catálogo para agregarlo.
        </p>
      </div>
    );

  const orderBody = (
    <div className="space-y-4">
      {cartList(true)}
      <div className="rounded-2xl bg-ink p-4 text-paper">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[11px] font-extrabold uppercase tracking-[0.18em] text-paper/60">
            Subtotal · {itemCount} {itemCount === 1 ? "artículo" : "artículos"}
          </span>
          <span className="display text-3xl tabular-nums">
            {money(subtotal, currency)}
          </span>
        </div>
        <button
          type="button"
          disabled={!cart.length}
          onClick={() => {
            setMobileTicketOpen(false);
            setPhase("cobro");
          }}
          className="focus-ring group mt-3 flex w-full items-center justify-center gap-2 rounded-xl2 bg-matcha-light px-4 py-3.5 text-sm font-extrabold text-ink transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          Continuar al cobro
          <span
            aria-hidden
            className="transition-transform group-hover:translate-x-1 motion-reduce:transition-none"
          >
            →
          </span>
        </button>
      </div>
    </div>
  );

  /* Control segmentado: una sola opción activa, como un interruptor múltiple. */
  const segmented = <T extends string | number>(opts: {
    items: { value: T; label: ReactNode }[];
    value: T | null;
    onChange: (value: T) => void;
    aria: string;
  }) => (
    <div
      role="group"
      aria-label={opts.aria}
      className="flex flex-1 flex-wrap gap-1 rounded-full bg-cream p-1"
    >
      {opts.items.map((it) => {
        const selected = opts.value === it.value;
        return (
          <button
            key={String(it.value)}
            type="button"
            aria-pressed={selected}
            onClick={() => opts.onChange(it.value)}
            className={cx(
              "focus-ring flex-1 whitespace-nowrap rounded-full px-3 py-2 text-xs font-extrabold transition",
              selected
                ? "bg-white text-ink shadow-card"
                : "text-muted hover:text-ink",
            )}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );

  /* Fila de porcentaje: segmentado + campo libre (descuento y propina). */
  const pctRow = (opts: {
    label: string;
    chips: { pct: number; text: string }[];
    activePct: number | null;
    onChip: (pct: number) => void;
    custom: string;
    onCustom: (text: string) => void;
    aria: string;
  }) => (
    <div>
      <p className="eyebrow">{opts.label}</p>
      <div className="mt-2 flex items-center gap-2">
        {segmented({
          items: opts.chips.map((c) => ({ value: c.pct, label: c.text })),
          value: opts.activePct,
          onChange: opts.onChip,
          aria: opts.label,
        })}
        <Input
          type="text"
          inputMode="decimal"
          autoComplete="off"
          aria-label={opts.aria}
          placeholder="Otro %"
          value={opts.custom}
          onChange={(e) => {
            const text = numericText(e.target.value);
            if (text !== null) opts.onCustom(text);
          }}
          className={cx(
            "!w-[5.5rem] shrink-0 rounded-full !py-2 text-center",
            opts.custom !== "" && "border-matcha bg-matcha-mist font-extrabold",
          )}
        />
      </div>
    </div>
  );

  /* Desglose del ticket final: subtotal, descuento, propina y total. */
  const ticketTotals = (
    <div className="space-y-1.5 border-t-2 border-dashed border-line pt-4">
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted">
          Subtotal · {itemCount} {itemCount === 1 ? "artículo" : "artículos"}
        </span>
        <span className="font-bold tabular-nums text-ink">{money(subtotal, currency)}</span>
      </div>
      {discountAmount > 0 ? (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted">{discountLabel}</span>
          <span className="font-bold tabular-nums text-matcha-deep">
            −{money(discountAmount, currency)}
          </span>
        </div>
      ) : null}
      {tip > 0 ? (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted">Propina · {pctLabel(tipPctApplied)}%</span>
          <span className="font-bold tabular-nums text-ink">+{money(tip, currency)}</span>
        </div>
      ) : null}
      <div className="flex items-baseline justify-between pt-2">
        <span className="text-xs font-extrabold uppercase tracking-[0.18em] text-ink">
          Total
        </span>
        <span className="display text-3xl tabular-nums text-ink">
          {money(total, currency)}
        </span>
      </div>
    </div>
  );

  const change = Math.round((received - total) * 100) / 100;

  /*
   * Pantalla de cobro: el total como protagonista, controles segmentados y los
   * dos métodos de pago como botones grandes para tocarlos sin fallar.
   */
  const payBody = (
    <div className="space-y-5">
      <div
        className="relative overflow-hidden rounded-3xl px-6 py-6 text-center text-paper shadow-lift"
        style={{
          background:
            "radial-gradient(120% 140% at 100% 0%, rgba(122,140,84,0.55), transparent 55%), radial-gradient(90% 120% at 0% 100%, rgba(220,232,192,0.18), transparent 60%), #191a14",
        }}
      >
        <p className="text-[11px] font-extrabold uppercase tracking-[0.25em] text-paper/60">
          Total a cobrar
        </p>
        <p className="display mt-2 text-6xl leading-none tabular-nums">
          {money(total, currency)}
        </p>
        {discountAmount > 0 || tip > 0 ? (
          <p className="mt-3 text-xs text-paper/60">
            {discountAmount > 0 ? `Descuento −${money(discountAmount, currency)}` : ""}
            {discountAmount > 0 && tip > 0 ? " · " : ""}
            {tip > 0 ? `Propina +${money(tip, currency)}` : ""}
          </p>
        ) : null}
        {activePayment === "efectivo" && cashReceived !== "" && cashOk ? (
          <p className="mx-auto mt-4 inline-flex items-center gap-2 rounded-full bg-matcha-light px-4 py-1.5 text-sm font-extrabold text-ink">
            Cambio <span className="display text-lg tabular-nums">{money(change, currency)}</span>
          </p>
        ) : null}
      </div>

      <div>
        <p className="eyebrow">¿Dónde se consume?</p>
        <div className="mt-2 flex">
          {segmented<ServiceMode>({
            items: (["aqui", "llevar"] as ServiceMode[]).map((mode) => ({
              value: mode,
              label: (
                <span className="inline-flex items-center gap-1.5 text-sm">
                  <span aria-hidden>{SERVICE_META[mode].emoji}</span>
                  {SERVICE_META[mode].label}
                </span>
              ),
            })),
            value: serviceMode,
            onChange: setServiceMode,
            aria: "Modo de servicio",
          })}
        </div>
        {state.flags.inventario && packagingCount > 0 ? (
          <p className="mt-1.5 text-xs leading-5 text-muted">
            {serviceMode === "llevar"
              ? "Se descuentan vasos, tapas y demás empaque."
              : "No se descuenta empaque: se sirve en loza."}
          </p>
        ) : null}
      </div>

      {/* Descuento: solo se escribe el porcentaje (vacío = sin descuento). */}
      <div>
        <p className="eyebrow">Descuento</p>
        <div className="mt-2 flex items-center gap-2">
          <div className="relative flex-1">
            <Input
              type="text"
              inputMode="decimal"
              autoComplete="off"
              aria-label="Porcentaje de descuento"
              placeholder="Sin descuento · escribe el %"
              value={discountCustomPct}
              onChange={(e) => {
                const text = numericText(e.target.value);
                if (text !== null) setDiscountCustomPct(text);
              }}
              className={cx(
                "rounded-full !py-2.5 pr-10",
                discountCustomPct !== "" && "border-matcha bg-matcha-mist font-extrabold",
              )}
            />
            <span
              aria-hidden
              className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-sm font-extrabold text-muted"
            >
              %
            </span>
          </div>
          {discountCustomPct !== "" ? (
            <button
              type="button"
              onClick={() => setDiscountCustomPct("")}
              className="focus-ring shrink-0 rounded-full border border-line bg-white px-3 py-2 text-xs font-extrabold text-muted transition hover:border-danger hover:text-danger"
            >
              Quitar
            </button>
          ) : null}
        </div>
      </div>
      {discountOverflow ? (
        <p className="-mt-3 text-xs font-bold text-danger">
          El descuento no puede pasar de 100%; se aplica 100%.
        </p>
      ) : null}

      {pctRow({
        label: "Propina",
        chips: [{ pct: 0, text: "Sin" }, ...TIP_PCTS.map((pct) => ({ pct, text: `${pct}%` }))],
        activePct: tipTyped ? null : tipPct,
        onChip: (pct) => {
          setTipPct(pct);
          setTipCustomPct("");
        },
        custom: tipCustomPct,
        onCustom: setTipCustomPct,
        aria: "Otro porcentaje de propina",
      })}
      {tipOverflow ? (
        <p className="-mt-3 text-xs font-extrabold text-danger">
          La propina no puede pasar del 100% del consumo.
        </p>
      ) : null}

      {/* ------------------------------- Lealtad -------------------------------- */}
      {SHOW_LEALTAD_UI && state.flags.lealtad ? (
        <div className="border-t border-line pt-4">
          <p className="eyebrow">Cliente</p>
          {state.customers.length ? (
            <>
              <select
                aria-label="Cliente de lealtad"
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value)}
                className="focus-ring mt-2 w-full rounded-full border border-line bg-white px-4 py-2.5 text-sm font-bold text-ink"
              >
                <option value="">Venta al público</option>
                {state.customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} · {c.points} pts
                  </option>
                ))}
              </select>
              {selectedCustomer ? (
                <p className="mt-1.5 text-xs text-muted">
                  Sumará {pointsFor(total, state.settings.pointsPerCurrency)}{" "}
                  puntos a {selectedCustomer.name}.
                </p>
              ) : null}
            </>
          ) : (
            <p className="mt-2 text-xs leading-5 text-muted">
              Todavía no hay clientes registrados.{" "}
              <Link
                href="/clientes"
                className="font-bold text-matcha-deep hover:underline"
              >
                Registra el primero
              </Link>
              .
            </p>
          )}
        </div>
      ) : null}

      {/* --------------------------------- Pago ---------------------------------- */}
      <div>
        <p className="eyebrow">Método de pago</p>
        <div className="mt-2 grid grid-cols-2 gap-3">
          {paymentOptions.map((opt) => {
            const selected = activePayment === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => setPayment(opt.id)}
                aria-pressed={selected}
                className={cx(
                  "focus-ring relative flex min-h-[8.5rem] flex-col items-center justify-center gap-2 rounded-3xl border-2 px-3 py-5 transition motion-reduce:transition-none",
                  selected
                    ? "border-matcha-deep bg-matcha-deep text-paper shadow-pop"
                    : "border-line bg-white text-ink hover:-translate-y-0.5 hover:border-matcha hover:shadow-card motion-reduce:hover:translate-y-0",
                )}
              >
                {selected ? (
                  <span className="absolute right-3 top-3 flex h-6 w-6 items-center justify-center rounded-full bg-matcha-light text-xs font-extrabold text-ink">
                    ✓
                  </span>
                ) : null}
                <span aria-hidden className="text-5xl leading-none">
                  {opt.emoji}
                </span>
                <span className="display text-xl">{PAYMENT_META[opt.id].label}</span>
              </button>
            );
          })}
        </div>

        {activePayment === "efectivo" ? (
          <div className="mt-3 space-y-2">
            {/* Recibido ocupa casi todo el ancho; «Exacto» al lado, más chico. */}
            <div className="flex items-stretch gap-2">
              <div className="relative flex-1">
                <span
                  aria-hidden
                  className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-lg font-extrabold text-muted"
                >
                  $
                </span>
                <Input
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  aria-label="Efectivo recibido"
                  placeholder="Recibido"
                  value={cashReceived}
                  onChange={(e) => {
                    const text = numericText(e.target.value);
                    if (text !== null) setCashReceived(text);
                  }}
                  className="h-14 rounded-2xl !pl-9 text-lg font-extrabold"
                />
              </div>
              <button
                type="button"
                onClick={() => setCashReceived(String(total))}
                aria-pressed={cashReceived !== "" && received === total}
                className={cx(
                  "focus-ring w-28 shrink-0 rounded-2xl border-2 text-sm font-extrabold transition",
                  cashReceived !== "" && received === total
                    ? "border-matcha-deep bg-matcha-deep text-paper"
                    : "border-line bg-white text-ink hover:border-matcha",
                )}
              >
                Exacto
              </button>
            </div>
            {cart.length && cashReceived !== "" && !cashOk ? (
              <p className="text-sm font-extrabold text-danger">
                Faltan {money(Math.round((total - received) * 100) / 100, currency)}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      <button
        type="button"
        disabled={!canCharge}
        onClick={() => void handleCheckout()}
        className="focus-ring flex h-16 w-full items-center justify-center gap-3 rounded-2xl bg-gradient-to-r from-matcha-deep to-matcha text-lg font-extrabold text-paper shadow-pop transition hover:brightness-110 disabled:cursor-not-allowed disabled:from-line disabled:to-line disabled:text-muted disabled:shadow-none"
      >
        {busy ? "Cobrando…" : (
          <>
            Cobrar
            <span className="display text-2xl tabular-nums">{money(total, currency)}</span>
          </>
        )}
      </button>
      {cashClosedToday ? (
        <p className="text-center text-xs text-muted">
          La caja de hoy está cerrada. Un administrador debe reabrir el turno en
          Corte de caja.
        </p>
      ) : null}
    </div>
  );

  /* --------------------------------- Render --------------------------------- */

  if (!state.products.some((p) => p.active)) {
    return (
      <div className="space-y-6">
        <PageHeader
          eyebrow="Caja"
          title="Punto de venta"
          desc="Antes de cobrar hace falta tener productos activos en la carta."
        />
        <EmptyState
          emoji="🍵"
          title="La carta está vacía"
          desc={
            state.role === "admin"
              ? "Crea tus productos en el módulo de Productos, o carga el catálogo sugerido desde Ajustes."
              : "Pídele a un administrador que dé de alta los productos del menú."
          }
          action={
            state.role === "admin" ? (
              <Link
                href="/productos"
                className="focus-ring inline-flex items-center rounded-full bg-matcha-deep px-5 py-2.5 text-sm font-bold text-paper shadow-pop hover:bg-matcha"
              >
                Ir a Productos
              </Link>
            ) : null
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-10 md:pb-0">
      <PageHeader
        eyebrow={
          cashClosedToday
            ? "Caja cerrada"
            : state.todayShift
              ? `Turno abierto · fondo ${money(state.todayShift.openingFloat, currency)}`
              : "Caja abierta"
        }
        title="Punto de venta"
        desc="Fase 1: arma la orden y personaliza cada bebida. Fase 2: ticket final, descuento, propina y pago. Cada venta crea su comanda y descuenta los insumos de la receta."
        actions={
          state.todayShift || cashClosedToday ? (
            <button
              type="button"
              onClick={() => setShiftCloseOpen(true)}
              className={cx(
                "focus-ring inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-extrabold transition",
                cashClosedToday
                  ? "bg-matcha-deep text-paper hover:bg-matcha"
                  : "border border-line bg-white text-ink hover:border-danger hover:text-danger",
              )}
            >
              <span aria-hidden>{cashClosedToday ? "📊" : "🌙"}</span>
              {cashClosedToday ? "Resultados del día" : "Terminar turno"}
            </button>
          ) : null
        }
      />

      {/* Turno: sin apertura no se vende; el cierre enseña los resultados. */}
      {!state.todayShift && !cashClosedToday ? <ShiftStartOverlay /> : null}
      <ShiftCloseModal
        open={shiftCloseOpen}
        onClose={() => setShiftCloseOpen(false)}
      />

      {cashClosedToday ? (
        <Card className="flex flex-wrap items-center justify-between gap-3 border-amber/40 bg-amber/5">
          <div className="flex items-center gap-3">
            <span className="text-2xl" aria-hidden>
              🔒
            </span>
            <div>
              <p className="text-sm font-extrabold text-ink">
                Ventas en pausa: el corte de hoy ya se registró
              </p>
              <p className="mt-0.5 text-xs leading-5 text-muted">
                Para seguir cobrando hay que reabrir el turno desde Corte de caja.
              </p>
            </div>
          </div>
          {state.role === "admin" ? (
            <Link
              href="/corte"
              className="focus-ring rounded-full border border-amber/40 px-4 py-2 text-xs font-extrabold text-amber transition hover:bg-amber/10"
            >
              Ir a Corte de caja
            </Link>
          ) : null}
        </Card>
      ) : null}

      {/* ------------------------------ Fases ------------------------------- */}
      <nav
        aria-label="Fases del cobro"
        className="flex w-full max-w-xl items-center gap-1 rounded-full border border-line bg-white p-1.5 shadow-card"
      >
        {(
          [
            { id: "orden", n: 1, label: "Orden" },
            { id: "cobro", n: 2, label: "Ticket y pago" },
          ] as const
        ).map((step, i) => {
          const current = phase === step.id;
          const done = step.id === "orden" && phase === "cobro";
          const blocked = step.id === "cobro" && !cart.length;
          return (
            <div key={step.id} className="flex flex-1 items-center gap-1">
              {i > 0 ? (
                <span
                  aria-hidden
                  className={cx(
                    "h-0.5 w-6 shrink-0 rounded-full transition-colors",
                    phase === "cobro" ? "bg-matcha" : "bg-line",
                  )}
                />
              ) : null}
              <button
                type="button"
                onClick={() => !blocked && setPhase(step.id)}
                disabled={blocked}
                aria-current={current ? "step" : undefined}
                className={cx(
                  "focus-ring flex flex-1 items-center justify-center gap-2 rounded-full px-4 py-2.5 text-sm font-extrabold transition disabled:cursor-not-allowed disabled:opacity-40",
                  current ? "bg-ink text-paper shadow-pop" : "text-ink hover:bg-cream",
                )}
              >
                <span
                  className={cx(
                    "flex h-6 w-6 items-center justify-center rounded-full text-[11px]",
                    current
                      ? "bg-matcha-light text-ink"
                      : done
                        ? "bg-matcha text-paper"
                        : "bg-cream text-muted",
                  )}
                >
                  {done ? "✓" : step.n}
                </span>
                {step.label}
              </button>
            </div>
          );
        })}
      </nav>

      {phase === "cobro" ? (
        /* ----------------------- Fase 2: ticket final y pago ----------------------- */
        <div className="animate-rise gap-6 space-y-6 md:grid md:grid-cols-[minmax(0,1fr)_minmax(360px,460px)] md:items-start md:space-y-0 motion-reduce:animate-none">
          {/* Recibo: papel blanco con borde de corte en zigzag abajo. */}
          <div className="min-w-0">
            <div
              className="overflow-hidden rounded-t-3xl bg-white shadow-lift transition-[height] duration-500 ease-out motion-reduce:transition-none"
              style={rowH !== null ? { height: rowH } : undefined}
            >
              <div ref={receiptTopRef} className="px-6 pt-6">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-[10px] font-extrabold uppercase tracking-[0.25em] text-matcha-deep">
                      {state.settings.businessName}
                    </p>
                    <h2 className="display mt-1 text-3xl text-ink">Ticket final</h2>
                    <p className="mt-0.5 text-xs text-muted">
                      {new Date().toLocaleString("es-MX", {
                        timeZone: state.settings.timezone,
                        dateStyle: "medium",
                        timeStyle: "short",
                      })}{" "}
                      · {SERVICE_META[serviceMode].emoji} {SERVICE_META[serviceMode].label}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setPhase("orden")}
                    className="focus-ring shrink-0 rounded-full border border-line bg-white px-4 py-2 text-xs font-extrabold text-ink transition hover:border-matcha hover:text-matcha-deep"
                  >
                    ← Editar orden
                  </button>
                </div>
                <div className="mt-4 border-t-2 border-dashed border-line">
                  {cartList(false)}
                </div>
              </div>
              {/* Espaciador: empuja los totales abajo y crece con animación. */}
              <div
                aria-hidden
                className="transition-[height] duration-500 ease-out motion-reduce:transition-none"
                style={{ height: rowH !== null ? Math.max(rowH - receiptNatural, 0) : 0 }}
              />
              <div ref={receiptBottomRef} className="px-6 pb-4 pt-2">
                {ticketTotals}
                <p className="mt-5 text-center text-[10px] font-bold uppercase tracking-[0.3em] text-muted/70">
                  ¡Gracias por tu visita!
                </p>
              </div>
            </div>
            <div
              aria-hidden
              className="h-3 drop-shadow-[0_8px_8px_rgba(25,26,20,0.08)]"
              style={{
                background:
                  "linear-gradient(135deg, #fff 6px, transparent 0) 0 0 / 12px 12px repeat-x, linear-gradient(225deg, #fff 6px, transparent 0) 0 0 / 12px 12px repeat-x",
              }}
            />
          </div>
          <div
            className="overflow-hidden rounded-3xl border border-line bg-white shadow-card transition-[height] duration-500 ease-out motion-reduce:transition-none"
            style={rowH !== null ? { height: rowH + 12 } : undefined}
          >
            <div ref={payInnerRef} className="p-5 md:p-6">
              {payBody}
            </div>
          </div>
        </div>
      ) : (
        <>
      <div className="gap-5 md:grid md:grid-cols-[1fr_300px] xl:grid-cols-[1fr_360px]">
        {/* -------------------------------- Catálogo ------------------------------ */}
        <div className="min-w-0 space-y-4">
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar producto…"
            aria-label="Buscar producto"
            className="rounded-full px-5"
          />

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setCategory("todos")}
              aria-pressed={activeCategory === "todos"}
              className={cx(
                "focus-ring rounded-full px-4 py-2 text-xs font-extrabold transition",
                activeCategory === "todos"
                  ? "bg-ink text-paper"
                  : "border border-line bg-white text-ink hover:border-matcha",
              )}
            >
              Todos
            </button>
            {visibleCategories.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setCategory(c.id)}
                aria-pressed={activeCategory === c.id}
                className={cx(
                  "focus-ring rounded-full px-4 py-2 text-xs font-extrabold transition",
                  activeCategory === c.id
                    ? "bg-ink text-paper"
                    : "border border-line bg-white text-ink hover:border-matcha",
                )}
              >
                {c.emoji} {c.label}
              </button>
            ))}
          </div>

          {visibleProducts.length ? (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-2 lg:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {visibleProducts.map((p) => {
                // Cuántas piezas de este producto van ya en la orden.
                const inOrder = cart
                  .filter((l) => l.productId === p.id)
                  .reduce((n, l) => n + l.qty, 0);
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => openProduct(p)}
                    className={cx(
                      "card focus-ring group relative flex flex-col gap-3 p-3 text-left transition hover:-translate-y-0.5 hover:border-matcha hover:shadow-lift motion-reduce:transition-none motion-reduce:hover:translate-y-0",
                      inOrder > 0 && "border-matcha ring-2 ring-matcha/25",
                    )}
                  >
                    {inOrder > 0 ? (
                      <span className="absolute -right-2 -top-2 z-10 flex h-7 min-w-7 items-center justify-center rounded-full bg-matcha-deep px-2 text-xs font-extrabold text-paper shadow-pop">
                        {inOrder}
                      </span>
                    ) : null}
                    <span className="relative flex aspect-[4/3] w-full items-center justify-center overflow-hidden rounded-xl2 bg-gradient-to-br from-matcha-mist to-cream text-5xl">
                      <MediaImage
                        objectKey={p.imageKey}
                        alt=""
                        className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105 motion-reduce:transition-none"
                        fallback={
                          <span
                            aria-hidden
                            className="transition-transform duration-300 group-hover:scale-110 motion-reduce:transition-none"
                          >
                            {p.emoji}
                          </span>
                        }
                      />
                      {p.popular ? (
                        <span className="absolute left-2 top-2 rounded-full bg-ink/85 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-[0.12em] text-paper">
                          ★ Popular
                        </span>
                      ) : null}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="block text-sm font-extrabold leading-snug text-ink">
                        {p.name}
                      </span>
                      {p.desc ? (
                        <span className="mt-0.5 block truncate text-xs text-muted">
                          {p.desc}
                        </span>
                      ) : null}
                      <span className="mt-2 flex items-center justify-between gap-2">
                        <span className="display text-lg text-matcha-deep">
                          {money(p.price, currency)}
                        </span>
                        <span
                          aria-hidden
                          className="flex h-7 w-7 items-center justify-center rounded-full bg-ink text-sm font-extrabold text-paper transition group-hover:bg-matcha-deep"
                        >
                          +
                        </span>
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="rounded-xl2 border border-dashed border-line px-4 py-10 text-center text-sm text-muted">
              Sin resultados. Prueba con otro nombre u otra categoría.
            </p>
          )}
        </div>

        {/* --------------------------- Ticket (escritorio) ------------------------- */}
        <div className="hidden self-start md:sticky md:top-24 md:block">
          <div className="scrollbar-slim max-h-[calc(100dvh-8rem)] overflow-y-auto rounded-3xl border border-line bg-white p-4 shadow-card">
            <div className="mb-4 flex items-center justify-between gap-2">
              <h2 className="display text-2xl text-ink">Orden</h2>
              <div className="flex items-center gap-2">
                {cart.length ? (
                  <ConfirmButton
                    label="Vaciar"
                    confirmLabel="Sí, vaciar"
                    variant="ghost"
                    onConfirm={() => setCart([])}
                  />
                ) : null}
                <span className="rounded-full bg-matcha-mist px-2.5 py-1 text-[11px] font-extrabold text-matcha-deep">
                  {itemCount} {itemCount === 1 ? "artículo" : "artículos"}
                </span>
              </div>
            </div>
            {orderBody}
          </div>
        </div>
      </div>

      {/* ------------------------ Barra flotante (móvil) -------------------------- */}
      {itemCount > 0 ? (
        <button
          type="button"
          onClick={() => setMobileTicketOpen(true)}
          className="focus-ring animate-rise fixed inset-x-4 bottom-16 z-30 flex items-center justify-between gap-3 rounded-full bg-ink px-5 py-3.5 text-paper shadow-lift md:hidden"
        >
          <span className="text-sm font-extrabold">
            🧾 Orden · {itemCount} {itemCount === 1 ? "artículo" : "artículos"}
          </span>
          <span className="display text-lg">{money(subtotal, currency)}</span>
        </button>
      ) : null}

      <Modal
        open={mobileTicketOpen}
        onClose={() => setMobileTicketOpen(false)}
        title="Orden"
      >
        {orderBody}
      </Modal>
        </>
      )}

      {/* ------------------------ Modal de personalización ------------------------ */}
      <Modal
        open={!!draft && !!draftProduct}
        onClose={() => setDraft(null)}
        title={draftProduct ? `${draftProduct.emoji} ${draftProduct.name}` : ""}
      >
        {draft && draftProduct ? (
          <div className="space-y-5">
            {draftProduct.desc ? (
              <p className="-mt-2 text-sm leading-6 text-muted">
                {draftProduct.desc}
              </p>
            ) : null}

            <div className="flex items-center justify-between gap-3">
              <p className="eyebrow">Cantidad</p>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setDraft({ ...draft, qty: Math.max(1, draft.qty - 1) })}
                  disabled={draft.qty <= 1}
                  aria-label="Restar una unidad"
                  className="focus-ring h-10 w-10 rounded-full border border-line text-lg font-extrabold text-ink transition hover:border-matcha disabled:cursor-not-allowed disabled:opacity-40"
                >
                  −
                </button>
                <span className="display w-8 text-center text-xl text-ink">
                  {draft.qty}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setDraft({ ...draft, qty: Math.min(99, draft.qty + 1) })
                  }
                  disabled={draft.qty >= 99}
                  aria-label="Sumar una unidad"
                  className="focus-ring h-10 w-10 rounded-full border border-line text-lg font-extrabold text-ink transition hover:border-matcha disabled:cursor-not-allowed disabled:opacity-40"
                >
                  +
                </button>
              </div>
            </div>

            {draftProduct.mods.milk ? (
              <div>
                <p className="eyebrow">Leche</p>
                {availableMilks.length ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {availableMilks.map((m) => (
                      <Chip
                        key={m.id}
                        active={draft.milkId === m.id}
                        onClick={() => setDraft({ ...draft, milkId: m.id })}
                      >
                        {m.name}
                        {m.surcharge > 0 ? ` +${money(m.surcharge, currency)}` : ""}
                      </Chip>
                    ))}
                  </div>
                ) : (
                  <p className="mt-2 text-xs text-muted">
                    No hay leches activas en la carta.
                  </p>
                )}
              </div>
            ) : null}

            {draftProduct.mods.sweetness ? (
              <div>
                <p className="eyebrow">Dulzor</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {SWEETNESS_STEPS.map((s) => (
                    <Chip
                      key={s}
                      active={draft.sweetness === s}
                      onClick={() => setDraft({ ...draft, sweetness: s })}
                    >
                      {sweetnessLabel(s)}
                    </Chip>
                  ))}
                </div>
              </div>
            ) : null}

            {draftProduct.mods.temperature ? (
              <div>
                <p className="eyebrow">Temperatura</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {(["caliente", "frio"] as Temperature[]).map((t) => (
                    <Chip
                      key={t}
                      active={draft.temperature === t}
                      onClick={() => setDraft({ ...draft, temperature: t })}
                    >
                      {TEMP_LABEL[t]} {TEMP_EMOJI[t]}
                    </Chip>
                  ))}
                </div>
              </div>
            ) : null}

            {draftProduct.mods.extras && availableExtras.length ? (
              <div>
                <p className="eyebrow">Extras</p>
                <div className="mt-2 space-y-2">
                  {availableExtras.map((e) => {
                    const on = draft.extraIds.includes(e.id);
                    return (
                      <label
                        key={e.id}
                        className={cx(
                          "flex cursor-pointer items-center justify-between gap-3 rounded-xl2 border px-3.5 py-2.5 text-sm font-bold text-ink transition",
                          on
                            ? "border-matcha bg-matcha-mist"
                            : "border-line bg-white hover:border-matcha",
                        )}
                      >
                        <span className="flex min-w-0 items-center gap-2.5">
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() =>
                              setDraft({
                                ...draft,
                                extraIds: on
                                  ? draft.extraIds.filter((id) => id !== e.id)
                                  : [...draft.extraIds, e.id],
                              })
                            }
                            className="h-4 w-4 shrink-0 accent-matcha-deep"
                          />
                          <span className="min-w-0 break-words">{e.name}</span>
                        </span>
                        <span className="shrink-0 text-xs font-extrabold text-muted">
                          +{money(e.price, currency)}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            ) : null}

            <div>
              <p className="eyebrow">Notas para barra</p>
              <Input
                value={draft.notes}
                onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                placeholder="Ej. sin popote, nombre para el vaso…"
                aria-label="Notas para barra"
                maxLength={200}
                className="mt-2 rounded-full"
              />
            </div>

            <Button variant="matcha" className="w-full" onClick={confirmDraft}>
              {draft.lineKey ? "Guardar" : "Agregar"} ·{" "}
              {money(draftUnit * draft.qty, currency)}
            </Button>
          </div>
        ) : null}
      </Modal>

      {/* ----------------------------- Modal de éxito ----------------------------- */}
      <Modal
        open={!!success}
        onClose={() => setSuccess(null)}
        title="Cobro completado"
      >
        {success ? (
          <div className="text-center">
            <span className="text-5xl" aria-hidden>
              🎉
            </span>
            <p className="display mt-4 text-2xl text-ink">
              Venta #{success.folio} registrada
            </p>
            <p className="display mt-2 text-3xl text-matcha-deep">
              {money(success.total, currency)}
            </p>
            {/* Botones grandes para seguir rápido: «Nueva venta» es lo más
                común, así que va primero, relleno y con el foco listo para
                Enter. */}
            <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <button
                type="button"
                autoFocus
                onClick={() => setSuccess(null)}
                className="focus-ring flex h-20 flex-col items-center justify-center gap-1 rounded-2xl bg-gradient-to-r from-matcha-deep to-matcha text-lg font-extrabold text-paper shadow-pop transition hover:brightness-110 active:scale-[0.98] motion-reduce:transition-none"
              >
                <span aria-hidden className="text-2xl leading-none">
                  ＋
                </span>
                Nueva venta
              </button>
              <Link
                href="/comandas"
                onClick={() => notify("Comanda enviada a barra")}
                className="focus-ring flex h-20 flex-col items-center justify-center gap-1 rounded-2xl border-2 border-line bg-white text-lg font-extrabold text-ink transition hover:border-matcha active:scale-[0.98] motion-reduce:transition-none"
              >
                <span aria-hidden className="text-2xl leading-none">
                  🧾
                </span>
                Ver comanda
              </Link>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
