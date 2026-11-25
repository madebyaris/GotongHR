import { fieldClass } from "../shell";

export function todayJakarta(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date());
}

export function SelectField({
  id,
  label,
  value,
  error,
  disabled,
  onChange,
  options,
}: {
  id: string;
  label: string;
  value: string;
  error: string | null;
  disabled: boolean;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="mt-4">
      <label className="block text-base font-medium" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        name={id}
        className={fieldClass}
        value={value}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Choose</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {error ? (
        <p className="mt-1 text-sm text-destructive" id={`${id}-error`}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
