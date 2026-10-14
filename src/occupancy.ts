/** Validate optional child occupancy before starting browser automation. */
export function validateChildren(
  children?: number,
  childAges?: number[]
): void {
  if (
    children !== undefined &&
    (!Number.isSafeInteger(children) || children < 0)
  ) {
    throw new Error("children must be a non-negative integer");
  }
  if (
    childAges !== undefined &&
    (!Array.isArray(childAges) ||
      childAges.some((age) => !Number.isInteger(age) || age < 0 || age > 17))
  ) {
    throw new Error("childAges must contain integer ages from 0 to 17");
  }
  if (
    children !== undefined &&
    childAges !== undefined &&
    childAges.length !== children
  ) {
    throw new Error("children must equal the number of childAges");
  }
}

/** Apply child occupancy without losing ages from search-derived URLs. */
export function applyChildren(
  params: URLSearchParams,
  children?: number,
  childAges?: number[]
): void {
  validateChildren(children, childAges);
  if (children === undefined && childAges === undefined) return;
  const count = children ?? childAges?.length ?? 0;
  params.set("group_children", String(count));
  params.delete("req_children");
  params.delete("age");
  params.delete("req_age");
  for (const age of childAges ?? []) {
    params.append("age", String(age));
  }
}
