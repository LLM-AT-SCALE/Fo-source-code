"use client";

export function AuthBrandingPanel() {
  return (
    <div
      className="relative hidden w-[50%] flex-col justify-between overflow-hidden lg:flex"
      style={{ backgroundImage: 'url(/login-bg.jpg)', backgroundSize: 'cover', backgroundPosition: 'center' }}
    >
      {/* Dark overlay for text readability */}
      <div className="absolute inset-0 bg-black/20" />

      {/* Logos - top */}
      <div className="relative z-10 p-10">
        <div className="inline-flex items-center gap-3 rounded-xl bg-white/90 px-4 py-2.5 shadow-lg backdrop-blur-sm">
          {/* Static branding logos sized by CSS height only — plain img avoids next/image layout constraints. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logos/llmatscale-logo.png" alt="LLM at Scale.AI" className="h-10" />
          <div className="h-8 w-px bg-gray-300" />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logos/athena-logo.jpg" alt="Athena" className="h-9 rounded" />
        </div>
      </div>

      {/* Top - FabOrchestrator branding */}
      <div className="relative z-10 flex flex-col items-center px-8 pt-8">
        <h2 className="text-[2.5rem] font-bold tracking-tight text-white">
          FabOrchestrator<span className="text-purple-300">.AI</span>
        </h2>
        <div className="mx-auto mt-3 h-0.5 w-14 bg-purple-300" />
        <p className="mt-4 text-center text-[0.95rem] font-medium uppercase tracking-[0.15em] text-white/60">
          Operations Command Center &mdash;<br />Secure Login
        </p>
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Footer */}
      <div className="relative z-10 px-10 pb-8">
        <p className="text-center text-xs text-white/30">
          &copy; {new Date().getFullYear()} LLMatscale.ai. All Rights Reserved.
        </p>
      </div>
    </div>
  );
}
