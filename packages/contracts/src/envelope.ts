export interface ApiError {
  code: string;
  message: string;
}

export interface ApiEnvelope<TData, TMeta = null> {
  data: TData | null;
  meta: TMeta;
  error: ApiError | null;
}

export function ok<TData, TMeta = null>(
  data: TData,
  meta: TMeta = null as TMeta,
): ApiEnvelope<TData, TMeta> {
  return { data, meta, error: null };
}

export function fail<TMeta = null>(
  code: string,
  message: string,
  meta: TMeta = null as TMeta,
): ApiEnvelope<null, TMeta> {
  return { data: null, meta, error: { code, message } };
}
