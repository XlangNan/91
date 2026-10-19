import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";

type PaginationSyncOptions = {
  active: boolean;
  page: number;
  pageSize: number;
  totalPages: number;
  settled: boolean;
  setPage: Dispatch<SetStateAction<number>>;
};

/** Defer retained pages' URL updates until their route becomes active again. */
export function useAdminPaginationSync({
  active,
  page,
  pageSize,
  totalPages,
  settled,
  setPage,
}: PaginationSyncOptions) {
  const previousPageSizeRef = useRef(pageSize);

  useEffect(() => {
    if (!active) return;

    if (previousPageSizeRef.current !== pageSize) {
      previousPageSizeRef.current = pageSize;
      if (page !== 1) setPage(1);
      return;
    }

    if (settled && page > totalPages) setPage(totalPages);
  }, [active, page, pageSize, totalPages, settled, setPage]);
}
