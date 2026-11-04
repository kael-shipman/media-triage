// The daemon's own XMP namespace (DESIGN.md, F9), as an exiftool config that defines it. exiftool can read fields of
// a namespace it doesn't know, but writes only those it has a definition for.
//
// One field, a list of each account's state:
//
//   <mediatriage:Accounts>
//     <rdf:Bag>
//       <rdf:li rdf:parseType="Resource">
//         <mediatriage:User>{Immich user ID}</mediatriage:User>
//         <mediatriage:Favorite>True</mediatriage:Favorite>      (left out when false)
//         <mediatriage:Visibility>archive</mediatriage:Visibility> (left out when "timeline")
//         <mediatriage:Albums>                                   (left out when there are none)
//           <rdf:Bag><rdf:li rdf:parseType="Resource">
//             <mediatriage:Id>{album ID}</mediatriage:Id>
//             <mediatriage:Name>{album name}</mediatriage:Name>
//           </rdf:li></rdf:Bag>
//         </mediatriage:Albums>
//       </rdf:li>
//     </rdf:Bag>
//   </mediatriage:Accounts>
//
// Immich's exiftool and Darktable's Exiv2 both keep it when they rewrite a sidecar (src/sidecars/writers.test.ts).

import { NAMESPACE } from "../core/xmp.ts";

/** The exiftool config (Perl) that defines the namespace. exiftool reads it only as its first argument (`-config`). */
export function exiftoolConfig(): string {
  const { prefix, uri } = NAMESPACE;
  return `# media-triage's XMP namespace. Written by media-triage; changes are lost.
%Image::ExifTool::UserDefined = (
    'Image::ExifTool::XMP::Main' => {
        ${prefix} => { SubDirectory => { TagTable => 'Image::ExifTool::UserDefined::${prefix}' } },
    },
);
%Image::ExifTool::UserDefined::${prefix} = (
    GROUPS => { 0 => 'XMP', 1 => 'XMP-${prefix}', 2 => 'Image' },
    NAMESPACE => { '${prefix}' => '${uri}' },
    WRITABLE => 'string',
    Accounts => {
        List => 'Bag',
        Struct => {
            STRUCT_NAME => 'MediaTriageAccount',
            NAMESPACE => '${prefix}',
            User => { },
            Favorite => { Writable => 'boolean' },
            Visibility => { },
            Albums => {
                List => 'Bag',
                Struct => {
                    STRUCT_NAME => 'MediaTriageAlbum',
                    NAMESPACE => '${prefix}',
                    Id => { },
                    Name => { },
                },
            },
        },
    },
);
1;
`;
}
