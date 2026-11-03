# Changelog

## [0.1.1](https://github.com/chrischall/juggle-mcp/compare/v0.1.0...v0.1.1) (2026-11-03)


### Bug Fixes

* recover from expired Juggle sessions and correct the favorites list ([#5](https://github.com/chrischall/juggle-mcp/issues/5)) ([2ca1f88](https://github.com/chrischall/juggle-mcp/commit/2ca1f8807abb9ce61b876ce3a2f6b863dc110f60))


### Documentation

* note that juggle_list_favorites no longer reports totalNumSitters ([#8](https://github.com/chrischall/juggle-mcp/issues/8)) ([3fc4b62](https://github.com/chrischall/juggle-mcp/commit/3fc4b623df6470c5bdc57c00a51eeb48435ce892))

## 0.1.0 (2026-11-03)


### Features

* add confirm-gated Juggle writes for jobs, applicants, cancel, messages, favorites and reviews ([91c2d99](https://github.com/chrischall/juggle-mcp/commit/91c2d997bab53e8947b791aa070ef055bddc22c2))
* add Juggle read tools for profile, bookings, sitters, messages, payments and locations ([397d157](https://github.com/chrischall/juggle-mcp/commit/397d1576ecdc62488da7961a59f85155bbedb223))
* add the juggle curl+jq skill and document every tool ([bbbf472](https://github.com/chrischall/juggle-mcp/commit/bbbf4721f941f51521c98925fd9a6e986b571d75))
* scaffold juggle-mcp with a signed-in Juggle client and healthcheck ([92515c8](https://github.com/chrischall/juggle-mcp/commit/92515c86cb0d975b9edfcf3fec91bc5d46816784))


### Bug Fixes

* price juggle_post_job estimates the way the site does ([953bd8b](https://github.com/chrischall/juggle-mcp/commit/953bd8b7d90ee4869a58feed20590338a76255ac))
* refuse juggle get routes that normalise onto a private page ([3fa04ca](https://github.com/chrischall/juggle-mcp/commit/3fa04ca79f822172a62287ce94d8b604b2396438))
* warn in tool descriptions when results carry third-party text ([b4d3662](https://github.com/chrischall/juggle-mcp/commit/b4d36624f74d0fc62f059309f99a5a722702efe9))


### Documentation

* map the whyjuggle.com family-side API from the JS bundle ([b0e4839](https://github.com/chrischall/juggle-mcp/commit/b0e48397aa886d2a1031d66e1054ca9de93c4cbe))
* record what was verified against a live Juggle account ([#2](https://github.com/chrischall/juggle-mcp/issues/2)) ([210388d](https://github.com/chrischall/juggle-mcp/commit/210388dec8d1e55fdbc970acefb7cf166ee35c8b))
