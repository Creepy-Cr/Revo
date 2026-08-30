import { MotionConfig } from 'framer-motion';
import { Navbar } from '@/components/landing/navbar';
import { Hero } from '@/components/landing/hero';
import { LiveProof } from '@/components/landing/live-proof';
import { Features } from '@/components/landing/features';
import { HowItWorks } from '@/components/landing/how-it-works';
import { Footer } from '@/components/landing/footer';
import { Particles } from '@/components/landing/particles';
import { BeamVideo } from '@/components/landing/beam-video';

export default function Landing() {
  return (
    <MotionConfig reducedMotion="user">
    <div className="min-h-screen bg-black selection:bg-primary/30 selection:text-white relative overflow-x-hidden">
      {/* Global Background Effects */}
      <div className="texture-luxe fixed inset-0 w-full h-full pointer-events-none z-[1]" aria-hidden="true" />
      
      <div className="relative z-10">
        <Navbar />
        <main className="relative">
          {/* Cinematic Background Lighting - Top Only */}
          <div className="absolute inset-x-0 top-0 h-[160vh] pointer-events-none overflow-hidden z-0 cinematic-beam-container">
            <div className="cinematic-beam-cone" />
            <BeamVideo />
            <Particles />
          </div>

          <Hero />
          <LiveProof />
          <Features />
          <HowItWorks />
        </main>
        <Footer />
      </div>
    </div>
    </MotionConfig>
  );
}
