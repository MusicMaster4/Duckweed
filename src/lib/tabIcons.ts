/**
 * Tab icon choices — default folder, plus a small set of accents so tabs
 * stay easy to tell apart at a glance.
 *
 * All glyphs are solid (filled) silhouettes in a 16×16 viewBox. Call sites
 * apply `.tab-glyph-fill` so they override the global stroke-only `svg` rule.
 */

export interface TabIcon {
  id: string;
  label: string;
  /** SVG path(s) drawn in a 16×16 viewBox, filled solid. */
  paths: readonly string[];
  /** Use evenodd when a path cuts holes out of a solid body. */
  evenodd?: boolean;
}

/** The folder is the default; `null` / absent icon means this. */
export const DEFAULT_TAB_ICON_ID = "folder";

export const TAB_ICONS: readonly TabIcon[] = [
  {
    id: "folder",
    label: "Folder",
    // Classic tabbed folder silhouette (single closed path).
    paths: [
      "M2.25 4.1A1.1 1.1 0 0 1 3.35 3h2.7l1.2 1.25h5.4A1.1 1.1 0 0 1 13.75 5.35v6.3A1.1 1.1 0 0 1 12.65 12.75h-9.3A1.1 1.1 0 0 1 2.25 11.65z",
    ],
  },
  {
    id: "terminal",
    label: "Terminal",
    // Solid window with prompt chevron + cursor bar cut out (evenodd).
    paths: [
      [
        // outer rounded rect
        "M3 3.25h10a1 1 0 0 1 1 1v7.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-7.5a1 1 0 0 1 1-1z",
        // chevron hole >
        "M4.4 6.15 6.55 8 4.4 9.85 3.55 8.85 4.85 8 3.55 7.15z",
        // cursor bar hole
        "M8 9.9h3.5v1.2H8z",
      ].join(""),
    ],
    evenodd: true,
  },
  {
    id: "code",
    label: "Code",
    paths: [
      "M5.85 3.4 1.75 8l4.1 4.6 1.2-1.35L4.3 8l2.75-3.25z",
      "M10.15 3.4l4.1 4.6-4.1 4.6-1.2-1.35L11.7 8l-2.75-3.25z",
      "M9.45 3.25 6.55 12.75h1.4l2.9-9.5z",
    ],
  },
  {
    id: "git",
    label: "Git",
    paths: [
      // nodes
      "M4.5 2.2a1.55 1.55 0 1 1 0 3.1 1.55 1.55 0 0 1 0-3.1z",
      "M4.5 10.7a1.55 1.55 0 1 1 0 3.1 1.55 1.55 0 0 1 0-3.1z",
      "M11.5 6.45a1.55 1.55 0 1 1 0 3.1 1.55 1.55 0 0 1 0-3.1z",
      // trunk
      "M3.85 5.3h1.3v5.4h-1.3z",
      // branch arm
      "M5.15 7.2h4.8v1.3H5.15z",
    ],
  },
  {
    id: "star",
    label: "Star",
    paths: [
      "M8 1.5 9.85 5.55l4.4.4-3.35 2.9 1.05 4.3L8 11.1l-3.95 2.05 1.05-4.3-3.35-2.9 4.4-.4z",
    ],
  },
  {
    id: "heart",
    label: "Heart",
    paths: [
      "M8 13.6S2.5 9.85 2.5 5.9A2.9 2.9 0 0 1 8 4.15 2.9 2.9 0 0 1 13.5 5.9C13.5 9.85 8 13.6 8 13.6z",
    ],
  },
  {
    id: "bolt",
    label: "Bolt",
    paths: ["M9.2 1.35 3.85 9.1h3.6L6.65 14.65 12.15 6.9H8.55z"],
  },
  {
    id: "rocket",
    label: "Rocket",
    paths: [
      // body + nose, window cut out
      [
        "M8 1.4c2.2 1.25 3.95 3.55 4.2 6.55-.7.55-1.55 1.05-2.5 1.25L8 14.35l-1.7-5.15c-.95-.2-1.8-.7-2.5-1.25C4.05 4.95 5.8 2.65 8 1.4z",
        "M8 5.1a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4z",
      ].join(""),
      // fins
      "M5.4 10.5 3.15 13.7l3-.6z",
      "M10.6 10.5 12.85 13.7l-3-.6z",
    ],
    evenodd: true,
  },
] as const;

const byId = new Map(TAB_ICONS.map((i) => [i.id, i]));

export function tabIconDef(id: string | null | undefined): TabIcon {
  if (!id) return TAB_ICONS[0];
  return byId.get(id) ?? TAB_ICONS[0];
}

export function isDefaultTabIcon(id: string | null | undefined): boolean {
  return !id || id === DEFAULT_TAB_ICON_ID;
}
