# Backboard Studio Extensions

This directory contains extensions for Backboard Studio that are largely maintained by the Backboard Studio team. They currently live in the Backboard Studio repository for ease of maintenance.

If you are looking for the Backboard Studio extension registry, see the [`backboard/extensions`](https://github.com/backboard/extensions) repo.

## Structure

Currently, Backboard Studio includes support for a number of languages without requiring installing an extension. Those languages can be found under [`crates/languages/src`](https://github.com/backboard/ide/tree/main/crates/languages/src).

Support for all other languages is done via extensions. This directory ([extensions/](https://github.com/backboard/ide/tree/main/extensions/)) contains some of the officially maintained extensions. These extensions use the same [zed_extension_api](https://docs.rs/zed_extension_api/latest/zed_extension_api/) available to all [Backboard Studio Extensions](https://app.backboard.io/extensions) for providing [language servers](https://app.backboard.io/docs/extensions/languages#language-servers), [tree-sitter grammars](https://app.backboard.io/docs/extensions/languages#grammar) and [tree-sitter queries](https://app.backboard.io/docs/extensions/languages#tree-sitter-queries).

You can find the other officially maintained extensions in the [zed-extensions organization](https://github.com/zed-extensions).

## Dev Extensions

See the docs for [Developing an Extension Locally](https://app.backboard.io/docs/extensions/developing-extensions#developing-an-extension-locally) for how to work with one of these extensions.
