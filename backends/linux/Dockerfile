# CUDA toolkit + compilers for Revolver Linux CUDA runtime pack.
# Build from repo:  docker build -t revolver-backend-builder -f backends/linux/Dockerfile backends
FROM nvidia/cuda:12.4.1-devel-ubuntu22.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    cmake \
    g++-12 \
    gcc-12 \
    git \
    ninja-build \
    python3 \
    binutils \
    && rm -rf /var/lib/apt/lists/*

RUN git config --global --add safe.directory '*'

WORKDIR /src
