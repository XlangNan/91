export type AdminScrollRouteIdentity = {
  key: string;
  pathname: string;
  search: string;
};

type ResolveAdminScrollTargetOptions = {
  previousRoute: AdminScrollRouteIdentity | null;
  nextPathname: string;
  nextSearch: string;
  storedScrollTop: number | undefined;
  currentScrollTop: number;
};

/**
 * Existing history entries own their saved position. A newly-created search
 * state on the same page inherits the visible position so filters and
 * pagination do not jump. Drive selection changes the page even though it
 * lives in the search params. A new page starts at the top.
 */
export function resolveAdminScrollTarget({
  previousRoute,
  nextPathname,
  nextSearch,
  storedScrollTop,
  currentScrollTop,
}: ResolveAdminScrollTargetOptions) {
  if (storedScrollTop !== undefined) return storedScrollTop;
  if (previousRoute?.pathname !== nextPathname) return 0;

  if (nextPathname.replace(/\/+$/, "") === "/admin/drives") {
    const previousDriveId = new URLSearchParams(previousRoute.search).get("drive") || null;
    const nextDriveId = new URLSearchParams(nextSearch).get("drive") || null;
    if (previousDriveId !== nextDriveId) return 0;
  }

  return currentScrollTop;
}
