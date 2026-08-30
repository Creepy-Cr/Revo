import { Link } from "wouter";
import { AlertTriangle, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-6">
      <div className="max-w-md w-full brutal-panel border-destructive">
        <div className="brutal-header bg-destructive/20 text-destructive border-b-destructive">
          <span className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" /> 404_NOT_FOUND
          </span>
        </div>
        <div className="p-8 flex flex-col items-center text-center space-y-6 bg-black/60 relative overflow-hidden">
          <div className="absolute inset-0 scanline opacity-30" />
          
          <div className="text-6xl font-semibold font-mono text-destructive drop-shadow-[0_0_15px_rgba(255,0,0,0.5)] tabular-nums tracking-tight leading-tight">
            404
          </div>
          
          <div className="space-y-2 relative z-10">
            <h2 className="text-foreground font-sans font-semibold uppercase tracking-[0.14em] text-lg">
              Invalid Trajectory
            </h2>
            <p className="text-muted-foreground font-mono text-xs leading-relaxed max-w-[250px] tabular-nums">
              The specified coordinate does not exist within the treasury engine's known state vectors.
            </p>
          </div>

          <Link href="/">
            <Button 
              variant="outline" 
              className="w-full mt-4 border-border text-foreground hover:bg-white hover:text-black transition-all group"
            >
              <ArrowLeft className="w-4 h-4 mr-2 group-hover:-translate-x-1 transition-transform" />
              RETURN TO COCKPIT
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
