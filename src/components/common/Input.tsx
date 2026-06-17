/**
 * Input component - 宣纸风格输入框
 * 统一输入框样式：text/password/url/number/select/range
 */

import { forwardRef, ReactNode } from 'react';

interface BaseInputProps {
  label?: string;
  error?: string;
  helperText?: string;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  fullWidth?: boolean;
}

interface TextualInputProps extends BaseInputProps, Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  type?: 'text' | 'password' | 'url' | 'number' | 'email';
}

export const Input = forwardRef<HTMLInputElement, TextualInputProps>(
  ({ label, error, helperText, leftIcon, rightIcon, fullWidth = true, className = '', ...props }, ref) => {
    const id = props.id || `input-${Math.random().toString(36).substr(2, 9)}`;

    const inputWrapperClasses = `
      relative flex items-center gap-2 rounded-md border transition-all duration-fast
      ${error ? 'border-seal-2' : 'border-line hover:border-ink-faint'}
      ${error ? 'bg-seal-2/5' : 'bg-paper'}
      focus-within:outline-none focus-within:border-seal focus-within:ring-2 focus-within:ring-seal/20
      ${fullWidth ? 'w-full' : ''}
    `;

    const inputClasses = `
      flex-1 bg-transparent text-ink placeholder:text-ink-faint
      text-sm px-3 py-2 focus:outline-none min-w-0 font-serif
    `;

    return (
      <div className={fullWidth ? 'w-full' : ''}>
        {label && (
          <label htmlFor={id} className="block text-sm font-medium text-ink-soft mb-1.5 font-serif">
            {label}
          </label>
        )}
        <div className={inputWrapperClasses}>
          {leftIcon && <div className="pl-3 text-ink-faint">{leftIcon}</div>}
          <input
            ref={ref}
            id={id}
            className={inputClasses}
            {...props}
          />
          {rightIcon && <div className="pr-3 text-ink-faint">{rightIcon}</div>}
        </div>
        {(error || helperText) && (
          <p className={`mt-1.5 text-xs font-serif ${error ? 'text-seal-2' : 'text-ink-faint'}`}>
            {error || helperText}
          </p>
        )}
      </div>
    );
  }
);

Input.displayName = 'Input';

interface SelectProps extends BaseInputProps {
  options: { value: string; label: string }[];
}

export const Select = forwardRef<HTMLSelectElement, SelectProps & Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'size'>>(
  ({ label, error, helperText, fullWidth = true, options, className = '', ...props }, ref) => {
    const id = props.id || `select-${Math.random().toString(36).substr(2, 9)}`;

    const selectWrapperClasses = `
      relative flex items-center rounded-md border transition-all duration-fast
      ${error ? 'border-seal-2' : 'border-line hover:border-ink-faint'}
      ${error ? 'bg-seal-2/5' : 'bg-paper'}
      focus-within:outline-none focus-within:border-seal focus-within:ring-2 focus-within:ring-seal/20
      ${fullWidth ? 'w-full' : ''}
    `;

    const selectClasses = `
      flex-1 bg-transparent text-ink
      text-sm px-3 py-2 focus:outline-none min-w-0 appearance-none cursor-pointer font-serif
    `;

    return (
      <div className={fullWidth ? 'w-full' : ''}>
        {label && (
          <label htmlFor={id} className="block text-sm font-medium text-ink-soft mb-1.5 font-serif">
            {label}
          </label>
        )}
        <div className={selectWrapperClasses}>
          <select ref={ref} id={id} className={selectClasses} {...props}>
            {options.map(opt => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <div className="pr-3 pointer-events-none text-ink-faint">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </div>
        </div>
        {(error || helperText) && (
          <p className={`mt-1.5 text-xs font-serif ${error ? 'text-seal-2' : 'text-ink-faint'}`}>
            {error || helperText}
          </p>
        )}
      </div>
    );
  }
);

Select.displayName = 'Select';

interface ToggleProps {
  label?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  helperText?: string;
}

export function Toggle({ label, checked, onChange, disabled = false, helperText }: ToggleProps) {
  return (
    <div className="flex items-center justify-between">
      <div>
        {label && (
          <label className="block text-sm font-medium text-ink font-serif">{label}</label>
        )}
        {helperText && (
          <p className="text-xs text-ink-faint mt-0.5 font-serif">{helperText}</p>
        )}
      </div>
      <button
        onClick={() => onChange(!checked)}
        disabled={disabled}
        className={`
          relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-fast
          ${checked ? 'bg-seal' : 'bg-paper border border-line'}
          ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
        `}
      >
        <span
          className={`
            inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-fast shadow-sm
            ${checked ? 'translate-x-6' : 'translate-x-1'}
          `}
        />
      </button>
    </div>
  );
}

interface RangeProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'className'> {
  label?: string;
  helperText?: string;
}

export function Range({ label, helperText, ...props }: RangeProps) {
  return (
    <div className="w-full">
      {label && (
        <label className="block text-sm font-medium text-ink-soft mb-1.5 font-serif">
          {label}: {props.value}
        </label>
      )}
      <input
        type="range"
        className="w-full h-2 bg-paper rounded-lg appearance-none cursor-pointer accent-seal"
        {...props}
      />
      {helperText && (
        <p className="mt-1.5 text-xs text-ink-faint font-serif">{helperText}</p>
      )}
    </div>
  );
}
