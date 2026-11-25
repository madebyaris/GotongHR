export interface FieldIssue {
  field: string;
  message: string;
}

export interface ApiError {
  code: string;
  message: string;
  fields?: FieldIssue[];
}

export interface ApiSuccess<TData, TMeta> {
  data: TData;
  meta: TMeta;
  error: null;
}

export interface ApiFailure<TMeta> {
  data: null;
  meta: TMeta;
  error: ApiError;
}

export type ApiEnvelope<TData, TMeta = null> = ApiSuccess<TData, TMeta> | ApiFailure<TMeta>;

export function ok<TData>(data: TData): ApiSuccess<TData, null>;
export function ok<TData, TMeta>(data: TData, meta: TMeta): ApiSuccess<TData, TMeta>;
export function ok(data: unknown, meta: unknown = null): ApiSuccess<unknown, unknown> {
  return { data, meta, error: null };
}

export function fail(code: string, message: string): ApiFailure<null>;
export function fail<TMeta>(code: string, message: string, meta: TMeta): ApiFailure<TMeta>;
export function fail(code: string, message: string, meta: unknown = null): ApiFailure<unknown> {
  return { data: null, meta, error: { code, message } };
}

export function failWithFields(
  code: string,
  message: string,
  fields: readonly FieldIssue[],
): ApiFailure<null> {
  return {
    data: null,
    meta: null,
    error: {
      code,
      message,
      fields: fields.map((field) => ({ field: field.field, message: field.message })),
    },
  };
}
