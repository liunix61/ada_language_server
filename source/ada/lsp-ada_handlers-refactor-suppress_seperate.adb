------------------------------------------------------------------------------
--                         Language Server Protocol                         --
--                                                                          --
--                     Copyright (C) 2021-2023, AdaCore                     --
--                                                                          --
-- This is free software;  you can redistribute it  and/or modify it  under --
-- terms of the  GNU General Public License as published  by the Free Soft- --
-- ware  Foundation;  either version 3,  or (at your option) any later ver- --
-- sion.  This software is distributed in the hope  that it will be useful, --
-- but WITHOUT ANY WARRANTY;  without even the implied warranty of MERCHAN- --
-- TABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public --
-- License for  more details.  You should have  received  a copy of the GNU --
-- General  Public  License  distributed  with  this  software;   see  file --
-- COPYING3.  If not, go to http://www.gnu.org/licenses for a complete copy --
-- of the license.                                                          --
------------------------------------------------------------------------------

with Libadalang.Analysis; use Libadalang.Analysis;

with Laltools.Common; use Laltools.Common;
with LAL_Refactor.Suppress_Separate;
use LAL_Refactor.Suppress_Separate;
with LAL_Refactor.Subprogram_Signature; use LAL_Refactor.Subprogram_Signature;

with VSS.JSON.Streams;
with VSS.Strings.Conversions;

with LSP.Ada_Contexts;
with LSP.Enumerations;
with LSP.Utils;
with LSP.Structures.LSPAny_Vectors; use LSP.Structures.LSPAny_Vectors;

package body LSP.Ada_Handlers.Refactor.Suppress_Seperate is

   ------------------------
   -- Append_Code_Action --
   ------------------------

   procedure Append_Code_Action
     (Self            : in out Command;
      Context         : LSP.Ada_Context_Sets.Context_Access;
      Commands_Vector : in out LSP.Structures.Command_Or_CodeAction_Vector;
      Target_Separate : Libadalang.Analysis.Basic_Decl)
   is
      Code_Action  : LSP.Structures.CodeAction;
      Subp_Name    : constant Libadalang.Analysis.Name :=
        Target_Separate.P_Defining_Name.F_Name;
      Where        : constant LSP.Structures.Location :=
        LSP.Utils.Get_Node_Location (Subp_Name);
      Action_Title : constant VSS.Strings.Virtual_String :=
        VSS.Strings.To_Virtual_String
          ("Suppress separate subprogram " & Subp_Name.Text);

   begin
      Self.Initialize
        (Context => Context,
         Where   => ((uri => Where.uri), Where.a_range.start));

      Code_Action :=
        (title       => Action_Title,
         kind        =>
           (Is_Set => True,
            Value  => LSP.Enumerations.RefactorRewrite),
         diagnostics => <>,
         edit        => (Is_Set => False),
         isPreferred => (Is_Set => False),
         disabled    => (Is_Set => False),
         command     =>
           (Is_Set => True,
            Value  =>
              (title      => <>,
               command   => VSS.Strings.Conversions.To_Virtual_String
                 (Command'External_Tag),
               arguments => Self.Write_Command)),
         data        => <>);

      Commands_Vector.Append
        (LSP.Structures.Command_Or_CodeAction'
           (Is_Command => False, CodeAction => Code_Action));
   end Append_Code_Action;

   ------------
   -- Create --
   ------------

   overriding function Create
     (Any : not null access LSP.Structures.LSPAny_Vector)
      return Command
   is
      use VSS.JSON.Streams;
      use VSS.Strings;
      use LSP.Structures.JSON_Event_Vectors;

      C : Cursor := Any.First;
   begin
      return Self : Command do
         pragma Assert (Element (C).Kind = Start_Array);
         Next (C);
         pragma Assert (Element (C).Kind = Start_Object);
         Next (C);

         while Has_Element (C)
           and then Element (C).Kind /= End_Object
         loop
            pragma Assert (Element (C).Kind = Key_Name);
            declare
               Key : constant Virtual_String := Element (C).Key_Name;
            begin
               Next (C);

               if Key = "context" then
                  Self.Context := Element (C).String_Value;

               elsif Key = "where" then
                  Self.Where := From_Any (C);

               else
                  Skip_Value (C);
               end if;
            end;

            Next (C);
         end loop;
      end return;
   end Create;

   --------------
   -- Refactor --
   --------------

   overriding procedure Refactor
     (Self    : Command;
      Handler : not null access LSP.Server_Notification_Receivers.
        Server_Notification_Receiver'Class;
      Client : not null access LSP.Client_Message_Receivers.
        Client_Message_Receiver'Class;
      Edits   : out LAL_Refactor.Refactoring_Edits)
   is
      use LAL_Refactor;

      Message_Handler : LSP.Ada_Handlers.Message_Handler renames
        LSP.Ada_Handlers.Message_Handler (Handler.all);
      Context         : LSP.Ada_Contexts.Context renames
        Message_Handler.Contexts.Get (Self.Context).all;

      Document : constant LSP.Ada_Documents.Document_Access :=
        Message_Handler.Get_Open_Document (Self.Where.textDocument.uri);

      Node : constant Ada_Node :=
        Document.Get_Node_At (Context, Self.Where.position);

      Target_Separate : constant Basic_Decl :=
        Get_Node_As_Name (Node).Parent.Parent.Parent.As_Basic_Decl;

      Suppressor : Separate_Suppressor;

      function Analysis_Units return Analysis_Unit_Array is
        (Context.Analysis_Units);
      --  Provides the Context Analysis_Unit_Array to the Mode_Changer

   begin
      if Target_Separate.Is_Null then

         Edits := (Diagnostics =>
                     [LAL_Refactor.Subprogram_Signature.Create
                        (Subp => Node,
                         Info => VSS.Strings.Conversions.To_Virtual_String
                           ("The target subprogram could "
                            & "not be resolved precisely."))],
                   others      => <>);
         return;
      end if;

      Suppressor := Create (Target_Separate);

      Edits := Suppressor.Refactor (Analysis_Units'Access);
   end Refactor;

   ----------------
   -- Initialize --
   ----------------

   procedure Initialize
     (Self            : in out Command'Class;
      Context         : LSP.Ada_Context_Sets.Context_Access;
      Where           : LSP.Structures.TextDocumentPositionParams) is
   begin
      Self.Context := Context.Id;
      Self.Where := Where;
   end Initialize;

   -------------------
   -- Write_Command --
   -------------------

   function Write_Command
     (Self : Command) return LSP.Structures.LSPAny_Vector
   is
      use VSS.JSON.Streams;

      Result : LSP.Structures.LSPAny_Vector;
   begin
      Result.Append (JSON_Stream_Element'(Kind => Start_Array));
      Result.Append (JSON_Stream_Element'(Kind => Start_Object));

      --  "context"
      Add_Key ("context", Result);
      To_Any (Self.Context, Result);

      --  "where"
      Add_Key ("where", Result);
      To_Any (Self.Where, Result);

      Result.Append (JSON_Stream_Element'(Kind => End_Object));
      Result.Append (JSON_Stream_Element'(Kind => End_Array));

      return Result;
   end Write_Command;

end LSP.Ada_Handlers.Refactor.Suppress_Seperate;
