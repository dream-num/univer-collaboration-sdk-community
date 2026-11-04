# Office import fixtures

These Office files contain only task-generated test text and numbers. No customer files are included.

`seed.*` cover the legacy and OOXML formats of Sheet and Doc, and PPTX for Slide. `nested-ole.pptx` contains an embedded Office attachment, which a Unit import stores as a `UnitEmbedded` file and a Unit export loads back.
