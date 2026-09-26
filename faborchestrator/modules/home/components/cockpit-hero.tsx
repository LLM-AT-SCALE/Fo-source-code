"use client"


export function CockpitHero() {
    return (
        <div className="text-center">
            <h1 className="text-[42px] font-extrabold tracking-[-1px]">
                Your{" "}
                <span
                    style={{
                        background: "linear-gradient(120deg,var(--brand-indigo-light),var(--cockpit-indigo))",
                        WebkitBackgroundClip: "text",
                        backgroundClip: "text",
                        WebkitTextFillColor: "transparent",
                    }}
                >
                    orchestration
                </span>{" "}
                cockpit.
            </h1>

            <div className="mt-2.5 text-[15px] font-medium" style={{ color: "var(--text-muted-cool)" }}>
                Unify systems. Automate workflows. Transform the enterprise.
            </div>
        </div>
    )
}
