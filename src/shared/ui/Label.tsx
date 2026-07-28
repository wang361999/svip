/**
 * Label 表单标签
 */
import type { LabelHTMLAttributes } from 'react';

export interface LabelProps extends LabelHTMLAttributes<HTMLLabelElement> {}

export function Label({ className = '', children, ...props }: LabelProps) {
  return (
    <label className={`block text-sm font-medium text-dark-300 mb-1.5 ${className}`} {...props}>
      {children}
    </label>
  );
}
