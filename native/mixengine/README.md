# MixEngine (native)

C++ headers mirroring `renderer/mixengine.js`, inspired by [Mixxx](https://github.com/mixxxdj/mixxx) analyzers (`AnalyzerSilence`, AutoDJ transition modes).

## Why JS ships by default

End-user Windows installs (`npm run dist` → NSIS) must work **without** Visual Studio. The Electron app therefore runs the JS MixEngine at runtime.

This folder is for optional native acceleration / verification when you have MSVC or clang:

```bat
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release
```

Link against your own N-API wrapper if you want a `.node` addon later. The public API is header-only in `mixengine.hpp`.

## License note

Algorithms here are **reimplemented** from public Mixxx behavior descriptions; do not copy Mixxx GPL sources into this MIT/proprietary app tree without a license review.
