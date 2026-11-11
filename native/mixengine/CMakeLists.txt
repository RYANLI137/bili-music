cmake_minimum_required(VERSION 3.16)
project(bilimusic_mixengine LANGUAGES CXX)
add_library(mixengine INTERFACE)
target_include_directories(mixengine INTERFACE ${CMAKE_CURRENT_SOURCE_DIR})
target_compile_features(mixengine INTERFACE cxx_std_17)

add_executable(mixengine_smoke smoke.cpp)
target_link_libraries(mixengine_smoke PRIVATE mixengine)
