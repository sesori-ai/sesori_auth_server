export function dateFromBigQuery(input: { value: unknown }): Date | null {
  // The BigQuery SDK may wrap TIMESTAMP values as { value: string } rather
  // than returning Date instances, depending on the query path.
  const value =
    typeof input.value === "object" && input.value !== null && "value" in input.value
      ? (input.value as { value: unknown }).value
      : input.value;
  if (typeof value !== "string" && typeof value !== "number" && !(value instanceof Date)) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
