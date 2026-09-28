import type { Metadata } from "next";
import { SiteHeader } from "@/components/SiteHeader";
import { products } from "@/data/products";
import "./home.css";

export const metadata: Metadata = {
  title: "Backboard Studio — Choose your space",
  description:
    "Find your way to Kevin, the CLI, Nash, Backboard Canvas, and Backboard Apps.",
};

export default function StudioHome() {
  return (
    <>
      <a className="hub-skip" href="#products">
        Skip to products
      </a>
      <SiteHeader variant="hub" />
      <main className="studio-home">
        <div className="hub-intro">
          <p className="hub-eyebrow">THE BACKBOARD FAMILY</p>
          <h1>
            What will you <br />
            <span>make today?</span>
          </h1>
          <p className="hub-description">Pick your space. Get into it.</p>
        </div>
        <nav
          id="products"
          className="hub-products"
          aria-label="Backboard products"
        >
          {products.map((product) => {
            const content = (
              <>
                <div
                  className={`hub-art hub-art--${product.id}`}
                  aria-hidden="true"
                >
                  <img src={product.artwork} alt="" />
                  {product.id === "cli" && (
                    <span className="hub-terminal">&gt;_</span>
                  )}
                </div>
                <div className="hub-product-label">
                  <h2>
                    {product.name.startsWith("Backboard ") ? (
                      <>
                        <span className="hub-parent">Backboard</span>
                        {product.name.replace("Backboard ", "")}
                      </>
                    ) : (
                      product.name
                    )}
                  </h2>
                  <span className="hub-action">
                    {product.action}
                    {product.href && <span aria-hidden="true">↗</span>}
                  </span>
                </div>
              </>
            );
            return product.href ? (
              <a
                key={product.id}
                href={product.href}
                className={`hub-product hub-product--${product.id}`}
              >
                {content}
              </a>
            ) : (
              <div
                key={product.id}
                className={`hub-product hub-product--${product.id} hub-product--pending`}
                aria-label={`${product.name} — coming soon`}
              >
                {content}
              </div>
            );
          })}
        </nav>
        <footer className="hub-footer">
          <span>Different spaces. One Backboard.</span>
          <a href="https://docs.backboard.io">Need a hand? Read the docs ↗</a>
        </footer>
      </main>
    </>
  );
}
