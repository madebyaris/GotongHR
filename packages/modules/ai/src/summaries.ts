/**
 * Original notes for the assistant. They are not copies of PP, PMK, or UU text.
 * Each one says "not the statute" so a reader can tell the note from the law.
 */

export interface CuratedSummary {
  citationRef: string;
  documentId: string;
  title: string;
  content: string;
}

export const curatedSummaries: readonly CuratedSummary[] = [
  {
    citationRef: "summary:pp-58-2023",
    documentId: "01900000-0000-7000-8000-000000000058",
    title: "PP 58/2023 summary",
    content:
      "This note is not the statute. It is a short original summary of Government Regulation No. 58 of 2023 (PP 58/2023) on withholding Article 21 income tax, often called PPh 21, from employment income. The regulation is about monthly withholding and a year-end calculation that settles the difference. GotongHR keeps this note so the assistant can name the topic. It is not the official text of PP 58/2023. Read the official regulation before you rely on it.",
  },
  {
    citationRef: "summary:pmk-168-2023",
    documentId: "01900000-0000-7000-8000-000000000168",
    title: "PMK 168/2023 summary",
    content:
      "This note is not the statute. It is a short original summary of Minister of Finance Regulation No. 168 of 2023 (PMK 168/2023). The regulation describes how an employer withholds PPh 21 during the year and how the annual calculation fits that withholding. This note does not reproduce the official tables or the regulation. Read the official regulation before you rely on it.",
  },
  {
    citationRef: "summary:pp-35-2021",
    documentId: "01900000-0000-7000-8000-000000000035",
    title: "PP 35/2021 summary",
    content:
      "This note is not the statute. It is a short original summary of Government Regulation No. 35 of 2021 (PP 35/2021) on fixed-term agreements (PKWT), outsourcing, working time, and termination. The topics include overtime, called lembur, and compensation when a fixed-term contract ends. This summary is not the official text of PP 35/2021. Read the official regulation before you rely on it.",
  },
  {
    citationRef: "summary:uu-pdp-27-2022",
    documentId: "01900000-0000-7000-8000-000000000027",
    title: "UU PDP summary",
    content:
      "This note is not the statute. It is a short original summary of Law No. 27 of 2022 on Personal Data Protection (UU PDP). The law is about when personal data may be processed, the rights of the person the data describes, and the duty to respond when a breach happens. This summary is not the official text. Read the official law before you rely on it.",
  },
];
