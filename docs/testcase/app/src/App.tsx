import { Button } from "@/components/ui/button"

const VIDEO_URL =
  "https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260314_131748_f2ca2a28-fed7-44c8-b9a9-bd9acdd5ec31.mp4"

const NAV_LINKS = [
  { label: "Home", active: true },
  { label: "Studio", active: false },
  { label: "About", active: false },
  { label: "Journal", active: false },
  { label: "Reach Us", active: false },
] as const

const displayFont = { fontFamily: "'Instrument Serif', serif" } as const

function App() {
  return (
    <div className="relative min-h-screen overflow-hidden">
      <video
        autoPlay
        loop
        muted
        playsInline
        className="absolute inset-0 z-0 h-full w-full object-cover"
      >
        <source src={VIDEO_URL} type="video/mp4" />
      </video>

      <nav className="relative z-10 mx-auto flex max-w-7xl flex-row items-center justify-between px-8 py-6">
        <div
          className="text-3xl tracking-tight text-foreground"
          style={displayFont}
        >
          Velorah<sup className="text-xs">®</sup>
        </div>

        <div className="hidden items-center gap-8 md:flex">
          {NAV_LINKS.map(({ label, active }) => (
            <a
              key={label}
              href="#"
              className={`text-sm transition-colors ${
                active
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {label}
            </a>
          ))}
        </div>

        <Button className="liquid-glass rounded-full px-6 py-2.5 text-sm text-foreground hover:scale-[1.03]">
          Begin Journey
        </Button>
      </nav>

      <main className="relative z-10 flex flex-col items-center px-6 py-[90px] pt-32 pb-40 text-center">
        <h1
          className="animate-fade-rise max-w-7xl text-5xl leading-[0.95] font-normal tracking-[-2.46px] sm:text-7xl md:text-8xl"
          style={displayFont}
        >
          Where <em className="not-italic text-muted-foreground">dreams</em>{" "}
          rise{" "}
          <em className="not-italic text-muted-foreground">
            through the silence.
          </em>
        </h1>

        <p className="animate-fade-rise-delay mt-8 max-w-2xl text-base leading-relaxed text-muted-foreground sm:text-lg">
          We&apos;re designing tools for deep thinkers, bold creators, and quiet
          rebels. Amid the chaos, we build digital spaces for sharp focus and
          inspired work.
        </p>

        <Button
          size="lg"
          className="animate-fade-rise-delay-2 liquid-glass mt-12 cursor-pointer rounded-full px-14 py-5 text-base text-foreground hover:scale-[1.03]"
        >
          Begin Journey
        </Button>
      </main>
    </div>
  )
}

export default App
