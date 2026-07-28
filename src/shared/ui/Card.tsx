/**
 * Card 组件 — 玻璃态卡片容器
 */
import type { HTMLAttributes } from 'react';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  padding?: 'none' | 'sm' | 'md' | 'lg';
}

const paddingClasses = {
  none: '',
  sm: 'p-3',
  md: 'p-4',
  lg: 'p-6',
};

export function Card({ padding = 'md', className = '', children, ...props }: CardProps) {
  return (
    <div className={`glass-card ${paddingClasses[padding]} ${className}`} {...props}>
      {children}
    </div>
  );
}
