import type { SVGProps } from "react";

export type IconName =
  | "arrow-right"
  | "arrow-up-right"
  | "calendar"
  | "check"
  | "chevron-down"
  | "clock"
  | "film"
  | "map-pin"
  | "menu"
  | "music"
  | "search"
  | "shield"
  | "sparkles"
  | "sport"
  | "stage"
  | "ticket"
  | "users"
  | "x";

interface IconProps extends SVGProps<SVGSVGElement> {
  name: IconName;
}

export function Icon({ name, ...props }: IconProps) {
  const content = {
    "arrow-right": <path d="M5 12h14m-6-6 6 6-6 6" />,
    "arrow-up-right": <path d="M7 17 17 7M8 7h9v9" />,
    calendar: (
      <>
        <rect x="3" y="5" width="18" height="16" rx="2" />
        <path d="M16 3v4M8 3v4M3 10h18" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    "chevron-down": <path d="m6 9 6 6 6-6" />,
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    film: (
      <>
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="M7 5v14M17 5v14M3 9h4m10 0h4M3 15h4m10 0h4" />
      </>
    ),
    "map-pin": (
      <>
        <path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z" />
        <circle cx="12" cy="10" r="2.5" />
      </>
    ),
    menu: <path d="M4 7h16M4 12h16M4 17h16" />,
    music: (
      <>
        <path d="M9 18V5l10-2v13" />
        <circle cx="6" cy="18" r="3" />
        <circle cx="16" cy="16" r="3" />
      </>
    ),
    search: (
      <>
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-4-4" />
      </>
    ),
    shield: <path d="M12 3 4.5 6v5.5c0 4.6 3.2 7.9 7.5 9.5 4.3-1.6 7.5-4.9 7.5-9.5V6L12 3Zm-3 9 2 2 4-5" />,
    sparkles: <path d="m12 3 1.2 4.1L17 9l-3.8 1.9L12 15l-1.2-4.1L7 9l3.8-1.9L12 3ZM5 15l.7 2.3L8 18l-2.3.7L5 21l-.7-2.3L2 18l2.3-.7L5 15Zm14-2 .7 2.3 2.3.7-2.3.7L19 19l-.7-2.3L16 16l2.3-.7L19 13Z" />,
    sport: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="m12 3 3 4-1 4H9L8 7l4-4Zm-9 9 5-1 3 4-2 5m12-8-5-1-3 4 2 5" />
      </>
    ),
    stage: (
      <>
        <path d="M4 4h16v16H4zM4 8c4 0 6 2 8 6 2-4 4-6 8-6" />
        <path d="M8 20v-3m8 3v-3" />
      </>
    ),
    ticket: <path d="M4 7a2 2 0 0 0 2-2h12a2 2 0 0 0 2 2v2a3 3 0 0 0 0 6v2a2 2 0 0 0-2 2H6a2 2 0 0 0-2-2v-2a3 3 0 0 0 0-6V7Zm8-1v12" />,
    users: (
      <>
        <circle cx="9" cy="8" r="3" />
        <path d="M3 20c0-4 2.5-7 6-7s6 3 6 7M16 5a3 3 0 0 1 0 6m1 3c2.4.7 4 3 4 6" />
      </>
    ),
    x: <path d="M6 6l12 12M18 6 6 18" />,
  } satisfies Record<IconName, React.ReactNode>;

  return (
    <svg
      aria-hidden="true"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {content[name]}
    </svg>
  );
}
