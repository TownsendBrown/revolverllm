# CUDA toolkit + compilers for Revolver Linux backend packs.
# Build from repo:  docker build -t revolver-backend-builder -f backends/linux/Dockerfile backends
FROM nvidia/cuda:11.8.0-devel-ubuntu22.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    cmake \
    g++-11 \
    gcc-11 \
    git \
    ninja-build \
    python3 \
    binutils \
    && rm -rf /var/lib/apt/lists/*

ENV CC=gcc-11 \
    CXX=g++-11 \
    CUDA_HOME=/usr/local/cuda \
    REVOLVER_BACKEND_DOCKER=1

WORKDIR /src
