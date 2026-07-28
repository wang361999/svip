/**
 * Input 组件 — 暗色主题输入框
 */
import { forwardRef, type InputHTMLAttributes } from 'react';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  error?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className = '', error = false, ...props }, ref) => {
    return (
      <input
        ref={ref}
        className={`w-full rounded-lg bg-dark-800 border px-3 py-2 text-sm text-slate-200 placeholder-dark-500 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 ${
          error ? 'border-red-500/50' : 'border-dark-600'
        } ${className}`}
        {...props}
      />
    );
  },
);
Input.displayName = 'Input';
