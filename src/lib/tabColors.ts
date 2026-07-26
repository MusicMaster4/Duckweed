/**
 * Tab accent swatches — Default (none) plus a spread of hues that sit
 * comfortably next to Duckweed's green house colour on a near-black chrome.
 */

export interface TabColor {
  id: string;
  label: string;
  /** Saturated fill used for the swatch and the tab tint. */
  hex: string;
}

export const TAB_COLORS: readonly TabColor[] = [
  { id: "moss", label: "Moss", hex: "#7be05a" },
  { id: "lime", label: "Lime", hex: "#b4e05a" },
  { id: "mint", label: "Mint", hex: "#5ae0a0" },
  { id: "teal", label: "Teal", hex: "#45cec4" },
  { id: "sky", label: "Sky", hex: "#5fa8f5" },
  { id: "indigo", label: "Indigo", hex: "#7b8cf0" },
  { id: "violet", label: "Violet", hex: "#c98bf0" },
  { id: "pink", label: "Pink", hex: "#f08bc8" },
  { id: "rose", label: "Rose", hex: "#f2686f" },
  { id: "coral", label: "Coral", hex: "#f08a60" },
  { id: "amber", label: "Amber", hex: "#f0c052" },
  { id: "gold", label: "Gold", hex: "#e0d05a" },
  { id: "sand", label: "Sand", hex: "#c4b08a" },
] as const;

const byId = new Map(TAB_COLORS.map((c) => [c.id, c]));

export function tabColorHex(id: string | null | undefined): string | null {
  if (!id) return null;
  return byId.get(id)?.hex ?? null;
}
