#include "mixengine.hpp"
#include <cstdio>
#include <vector>

int main() {
  std::vector<float> pcm(48000 * 4, 0.f);
  for (size_t i = 48000; i < 48000 * 3; ++i) pcm[i] = 0.2f;
  auto s = mixengine::detectSilence(pcm.data(), pcm.size(), 48000.0, 4.0);
  auto p = mixengine::planTransition(2.0, 4.0, 4.0, 120, 122, s.outroStart, s.lastSound, s.firstSound, s.introEnd, true, true, 1.0);
  std::printf("silence first=%.2f last=%.2f mode=%s fade=%.2f\n", s.firstSound, s.lastSound, p.mode.c_str(), p.fadeSec);
  return 0;
}
