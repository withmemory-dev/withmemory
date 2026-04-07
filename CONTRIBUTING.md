# Contributing to WithMemory

**Status:** WithMemory is in pre-alpha and not yet accepting public contributions. This document is a placeholder that will be fleshed out when the repository becomes public.

## When the repo goes public

When WithMemory opens to contributions, we will accept:

- Bug fixes with reproducible test cases
- Documentation improvements
- Examples showing integration with popular frameworks
- Extraction prompt improvements backed by eval results
- Performance improvements backed by benchmarks

We will generally not accept:

- Feature additions that introduce configuration options (the product is intentionally zero-config)
- Changes that couple the server to a specific database provider
- New dependencies without a clear justification
- Stylistic refactors without functional changes

## Development workflow (for the eventual public version)

1. Fork the repository
2. Create a feature branch from `main`
3. Follow the conventions documented in `CLAUDE.md`
4. Run `pnpm typecheck` and `pnpm format` before committing
5. Open a pull request with a clear description of what changed and why
6. Respond to review feedback

## Code of conduct

Be kind, be honest, assume good intent. We will add a formal code of conduct when the project grows.

## License

The SDK (`packages/sdk`) is licensed under Apache 2.0. The server (`packages/server`) is licensed under BUSL 1.1, converting to Apache 2.0 after four years. By contributing, you agree that your contributions will be licensed under the same terms as the file you are modifying.

## Questions

For now, open an issue on GitHub or email hello@withmemory.dev.
