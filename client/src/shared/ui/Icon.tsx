const paths = {
  overview: 'M3 3h7v7H3V3Zm11 0h7v7h-7V3ZM3 14h7v7H3v-7Zm11 0h7v7h-7v-7',
  connections: 'M7 3v5m10-5v5M5 8h14v4a7 7 0 0 1-14 0V8Zm7 11v3',
  tenants: 'M3 21V7l9-4v18M12 9h9v12M6 9h2m-2 4h2m-2 4h2m7-5h3m-3 4h3',
  usage: 'M4 20V10m7 10V4m7 16v-7M2 21h20',
  audit: 'M4 5h16M4 12h16M4 19h16',
  chat: 'M4 4h16v12H9l-5 4V4Z',
  documents: 'M6 3h8l4 4v14H6V3Zm8 0v5h5M9 12h6M9 16h6',
  operations: 'M3 12h4l3-8 4 16 3-8h4',
  users:
    'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm10-7a4 4 0 0 1 0 8m3 9v-2a4 4 0 0 0-3-4',
  collections: 'M3 7h7l2-3h9v16H3V7Zm4 5h10m-10 4h6',
  quality: 'm5 12 4 4L19 6M4 3h16v18H4V3Z',
  sync: 'M20 7h-5m5 0V2m0 5a8 8 0 0 0-14-2M4 17h5m-5 0v5m0-5a8 8 0 0 0 14 2',
  backups: 'M4 4h16v16H4V4Zm4 0v6h8V4M8 20v-6h8v6',
  settings:
    'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0-6v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2',
  menu: 'M4 6h16M4 12h16M4 18h16',
  arrow: 'm8 5 7 7-7 7',
  logout: 'M9 4H4v16h5m5-13 5 5-5 5m-5-5h10',
  search: 'M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm5-2 6 6',
  plus: 'M12 4v16M4 12h16',
  shield: 'm12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z',
} as const;
export type IconName = keyof typeof paths;
export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[name]} />
    </svg>
  );
}
