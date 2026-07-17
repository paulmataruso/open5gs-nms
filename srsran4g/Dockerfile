FROM ubuntu:22.04 AS fftw-builder

ENV DEBIAN_FRONTEND=noninteractive

# Build libfftw3f without any AVX/SSE3+ so it runs on Nehalem (SSE4.2 only).
# Ubuntu 22.04's system libfftw3f has 75K VEX-prefixed bytes; FFTW's plan()
# executes all code-path variants at startup and crashes with SIGILL on CPUs
# that lack AVX.
RUN apt-get update && apt-get install -y build-essential wget && \
    rm -rf /var/lib/apt/lists/*

RUN wget -q http://www.fftw.org/fftw-3.3.10.tar.gz && \
    tar xf fftw-3.3.10.tar.gz && \
    cd fftw-3.3.10 && \
    ./configure --prefix=/opt/fftw-noavx \
        --enable-single --enable-shared --disable-static \
        --enable-sse2 \
        --disable-avx --disable-avx2 --disable-avx512 \
        --disable-avx-128-fma && \
    make -j$(nproc) install && \
    cd / && rm -rf fftw-3.3.10*


FROM ubuntu:22.04 AS srs-builder

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    build-essential cmake git \
    libfftw3-dev libmbedtls-dev libboost-program-options-dev \
    libconfig++-dev libsctp-dev libzmq3-dev \
    pkg-config python3 && \
    rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 --branch release_22_10 \
    https://github.com/srsran/srsRAN_4G.git /srsran_4g

RUN cmake -S /srsran_4g -B /srsran_4g/build \
    -DCMAKE_BUILD_TYPE=Release \
    -DGCC_ARCH=nehalem \
    -DENABLE_AVX=OFF    -DHAVE_AVX=FALSE \
    -DENABLE_AVX2=OFF   -DHAVE_AVX2=FALSE \
    -DENABLE_AVX512=OFF -DHAVE_AVX512=FALSE \
    -DENABLE_FMA=OFF    -DHAVE_FMA=FALSE \
    -DENABLE_NEON=OFF \
    -DUSE_MKL=OFF \
    -DENABLE_ZEROMQ=ON \
    -DENABLE_UHD=OFF \
    -DENABLE_BLADERF=OFF \
    -DENABLE_SOAPYSDR=OFF \
    -DENABLE_SKIQ=OFF \
    "-DCMAKE_C_FLAGS=-mno-avx -mno-avx2 -mno-bmi -mno-bmi2 -mno-fma -mno-movbe" \
    "-DCMAKE_CXX_FLAGS=-mno-avx -mno-avx2 -mno-bmi -mno-bmi2 -mno-fma -mno-movbe" && \
    cmake --build /srsran_4g/build --target srsenb srsue -- -j$(nproc) && \
    cmake --install /srsran_4g/build


# ── Runtime image ────────────────────────────────────────────────────────────
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    libmbedtls-dev libboost-program-options-dev \
    libconfig++-dev libsctp-dev libzmq3-dev && \
    rm -rf /var/lib/apt/lists/*

COPY --from=srs-builder /usr/local/bin/srsenb              /usr/local/bin/srsenb
COPY --from=srs-builder /usr/local/bin/srsue               /usr/local/bin/srsue
COPY --from=srs-builder /usr/local/lib/libsrs*             /usr/local/lib/
COPY --from=srs-builder /usr/local/share/srsran/           /usr/share/srsran/

# Install default srsRAN configs so srsenb/srsue can find sib.conf, rr.conf, rb.conf
RUN mkdir -p /etc/srsran && \
    for f in /usr/share/srsran/*.example; do \
        cp "$f" "/etc/srsran/$(basename ${f%.example})"; \
    done

# Replace Ubuntu 22.04's AVX-enabled libfftw3f with our no-AVX build.
# Put it in /usr/local/lib so ldconfig prefers it over /usr/lib.
COPY --from=fftw-builder /opt/fftw-noavx/lib/libfftw3f.so.3*  /usr/local/lib/

RUN ldconfig

CMD ["/bin/bash"]
