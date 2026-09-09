// Command verify-crx checks that the OpenFullPage extension running in a
// browser is byte-for-byte the code in this repository.
//
// That check is only possible because the project has no build step: there is
// no bundler, transpiler or minifier between the source and the shipped files,
// so "identical" is the correct expectation rather than an approximation.
//
// It is deliberately a single static binary with no dependencies, a user
// verifying an extension should not have to install a toolchain to do it.
package main

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const usage = `verify-crx, prove an installed extension matches its source

  verify-crx compare <installed-dir> <source-dir>
      Every file Chrome is running must exist, unchanged, in the source tree.
      Chrome's own _metadata directory is ignored; extra files in the source
      tree (tests, tooling, docs) are expected and ignored.

  verify-crx zip <package.zip> <source-dir>
      The same check against a published .zip.

  verify-crx digest <dir>
      Print a SHA-256 for every file plus one digest over the whole tree, so
      two people can compare a single line instead of a directory.

On macOS an installed extension lives at:
  ~/Library/Application Support/Google/Chrome/<Profile>/Extensions/<id>/<version>/
`

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}

	var err error
	switch os.Args[1] {
	case "compare":
		err = requireArgs(4, compareDirs)
	case "zip":
		err = requireArgs(4, compareZip)
	case "digest":
		err = requireArgs(3, digestDir)
	case "-h", "--help", "help":
		fmt.Print(usage)
		return
	default:
		err = fmt.Errorf("unknown command %q", os.Args[1])
	}

	if err != nil {
		fmt.Fprintln(os.Stderr, "verify-crx:", err)
		os.Exit(1)
	}
}

func requireArgs(n int, run func(args []string) error) error {
	if len(os.Args) != n {
		return errors.New("wrong number of arguments\n\n" + usage)
	}
	return run(os.Args[2:])
}

// FILE TREES

type file struct {
	path string // slash-separated, relative to the tree root
	sum  [32]byte
	size int64
}

// walkTree hashes every regular file under root. Chrome adds _metadata/ to an
// installed extension after signing, and macOS scatters .DS_Store around;
// neither came from the repository, so neither is compared.
func walkTree(root string) (map[string]file, error) {
	files := map[string]file{}

	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)

		if d.IsDir() {
			if rel == "_metadata" || rel == ".git" || rel == "dist" || rel == "node_modules" {
				return filepath.SkipDir
			}
			return nil
		}
		if filepath.Base(rel) == ".DS_Store" {
			return nil
		}

		sum, size, err := hashFile(path)
		if err != nil {
			return err
		}
		files[rel] = file{path: rel, sum: sum, size: size}
		return nil
	})

	return files, err
}

func hashFile(path string) ([32]byte, int64, error) {
	var out [32]byte
	f, err := os.Open(path)
	if err != nil {
		return out, 0, err
	}
	defer f.Close()

	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return out, 0, err
	}
	copy(out[:], h.Sum(nil))
	return out, n, nil
}

// COMMANDS

func compareDirs(args []string) error {
	installed, err := walkTree(args[0])
	if err != nil {
		return fmt.Errorf("reading installed extension: %w", err)
	}
	source, err := walkTree(args[1])
	if err != nil {
		return fmt.Errorf("reading source tree: %w", err)
	}

	return report(args[0], installed, source)
}

func compareZip(args []string) error {
	r, err := zip.OpenReader(args[0])
	if err != nil {
		return fmt.Errorf("opening package: %w", err)
	}
	defer r.Close()

	packed := map[string]file{}
	for _, entry := range r.File {
		if entry.FileInfo().IsDir() {
			continue
		}
		rc, err := entry.Open()
		if err != nil {
			return err
		}
		h := sha256.New()
		n, err := io.Copy(h, rc)
		rc.Close()
		if err != nil {
			return err
		}
		var sum [32]byte
		copy(sum[:], h.Sum(nil))
		packed[entry.Name] = file{path: entry.Name, sum: sum, size: n}
	}

	source, err := walkTree(args[1])
	if err != nil {
		return fmt.Errorf("reading source tree: %w", err)
	}
	return report(args[0], packed, source)
}

func digestDir(args []string) error {
	files, err := walkTree(args[0])
	if err != nil {
		return err
	}

	overall := sha256.New()
	for _, name := range sortedKeys(files) {
		f := files[name]
		fmt.Printf("%s  %s\n", hex.EncodeToString(f.sum[:]), name)
		// Both name and content feed the tree digest, so a renamed file changes it.
		fmt.Fprintf(overall, "%s\x00%s\n", name, hex.EncodeToString(f.sum[:]))
	}

	fmt.Printf("\ntree-sha256  %s  (%d files)\n", hex.EncodeToString(overall.Sum(nil)), len(files))
	return nil
}

// REPORT

func report(label string, shipped, source map[string]file) error {
	var missing, changed []string

	for _, name := range sortedKeys(shipped) {
		got := shipped[name]
		want, ok := source[name]
		if !ok {
			missing = append(missing, name)
			continue
		}
		if got.sum != want.sum {
			changed = append(changed, fmt.Sprintf("%s (running %s, source %s)",
				name, short(got.sum), short(want.sum)))
		}
	}

	fmt.Printf("checked %d files from %s\n", len(shipped), label)

	if len(missing) == 0 && len(changed) == 0 {
		fmt.Println("\nOK, every shipped file is byte-identical to the source tree.")
		return nil
	}

	if len(missing) > 0 {
		fmt.Printf("\nNOT IN THE SOURCE TREE (%d):\n", len(missing))
		for _, name := range missing {
			fmt.Println("  ", name)
		}
	}
	if len(changed) > 0 {
		fmt.Printf("\nDIFFERENT FROM THE SOURCE TREE (%d):\n", len(changed))
		for _, name := range changed {
			fmt.Println("  ", name)
		}
	}

	fmt.Println(strings.Repeat("-", 68))
	fmt.Println("MISMATCH. The code running in the browser is not the code in this")
	fmt.Println("repository. Check you compared the same version before concluding")
	fmt.Println("anything, then report it on the issue tracker.")
	return errors.New("verification failed")
}

func short(sum [32]byte) string { return hex.EncodeToString(sum[:])[:12] }

func sortedKeys(m map[string]file) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
