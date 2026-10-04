NODE ?= node
YARN ?= yarn

.PHONY: install run test typecheck coverage build build-cross emit emit-c build-c clean

install:
	$(YARN) install --frozen-lockfile

run:
	$(NODE) cli/nat.ts $(ARGS)

test:
	$(NODE) --test test/*.test.ts

# The compilable surface is narrower than Node's, so the typecheck runs against
# scriptc's own declarations: what passes here is what the compiler accepts.
typecheck:
	$(YARN) typecheck

# How much of the program compiles statically, and a coded diagnostic for
# anything that does not.
coverage:
	$(YARN) coverage

# Builds the pinned LLVM shipping executable at dist/nat. Use `make emit-c`
# separately when you want to refresh the complete C inspection intermediary.
build:
	$(NODE) scripts/build.mjs

build-cross:
	$(NODE) scripts/build-cross.mjs

# Compiler intermediates for inspection: build/c contains nat.c plus the exact
# linked runtime C/header snapshot and compile recipe; the other lanes retain
# textual LLVM and typed IR. build/ is gitignored.
emit:
	$(NODE) scripts/emit.mjs all

emit-c:
	$(NODE) scripts/emit.mjs c

# Rebuild the program from the emitted C with an ordinary compiler — no scriptc
# involved. `make build-c CC="zig cc"` swaps the toolchain; `cd build/c && make`
# is the same thing through the snapshot's own Makefile.
build-c:
	$(NODE) scripts/build-c.mjs $(if $(CC),--cc "$(CC)",)

clean:
	rm -rf dist build .scriptc node_modules
