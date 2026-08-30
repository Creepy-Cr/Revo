import React from 'react';
import { useLocation } from 'wouter';
import { AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  resetKey?: any;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // Log primitives, not the Error object - the remote console relay
    // JSON-stringifies arguments, and Error properties are non-enumerable,
    // so the object form shows up as a useless "{}".
    console.error(
      `ErrorBoundary caught: ${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`,
      error?.stack ?? '(no stack)',
      errorInfo.componentStack ?? '(no component stack)',
    );
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps) {
    if (prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, error: null });
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center min-h-screen bg-background text-foreground p-6">
          <div className="max-w-md w-full brutal-panel border-destructive">
            <div className="brutal-header bg-destructive/10 text-destructive border-b-destructive">
              <span className="flex items-center gap-2"><AlertCircle className="w-4 h-4" /> System Failure</span>
            </div>
            <div className="p-6">
              <h2 className="text-xl font-semibold font-sans mb-4 tracking-tight leading-tight">Critical Rendering Error</h2>
              <div className="bg-muted p-4 font-mono text-xs overflow-auto max-h-48 text-muted-foreground border border-border mb-6 tabular-nums">
                {this.state.error?.message || 'Unknown error occurred'}
              </div>
              <Button 
                variant="destructive"
                className="w-full"
                onClick={() => {
                  this.setState({ hasError: false, error: null });
                  window.location.reload();
                }}
              >
                Reboot System
              </Button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
